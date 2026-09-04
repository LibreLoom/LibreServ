#!/bin/bash
set -euo pipefail

# Luna Connect — Zero-Downtime Deploy (blue/green via Caddy).
#
# Two instances (A :8101, B :8102) share one database (SQLite file or Postgres).
# Caddy health-checks /healthz. This script soft-drains one instance at a
# time (touch drain file → /healthz 503 → wait for Caddy to drop it → stop).
#
# IMPORTANT — what gets deployed (always built from source; never Forgejo release assets):
#   Remote refs always clobber the host checkout (reset --hard + clean -fd). Local dirt,
#   divergent commits, and leftover build artifacts do not win over --head/--branch/--tag.
#   No flags / --latest-tag: hard-reset to the newest luna-connect-v* tag, then build
#   (safe production default — tip of main is opt-in via --head).
#   --head: hard-reset to origin/main from any starting branch, then build.
#   --no-pull: build current checkout without fetching (warns if main is behind origin).
#   --branch NAME: hard-reset to origin/NAME when it exists, then build.
#   --tag NAME: hard-reset to that release tag, then build.
#
# Typical production update (from repo root, as root):
#   sudo ./luna-connect/deploy/deploy.sh                 # latest luna-connect-v* tag
#   sudo ./luna-connect/deploy/deploy.sh --latest-tag    # same as no flags
#   sudo ./luna-connect/deploy/deploy.sh --head          # tip of origin/main
#   sudo ./luna-connect/deploy/deploy.sh --head --force  # sick peer or both down (recovery)
#
# Explicit tagged release:
#   sudo ./luna-connect/deploy/deploy.sh --tag luna-connect-v0.2.17
#   sudo ./luna-connect/deploy/deploy.sh --allow-old-tag  # alias for --latest-tag

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="/opt/luna-connect"
DATA_DIR="/var/lib/luna-connect"
BINARY_NAME="luna-connect"
HEALTH_TIMEOUT=30
# Must exceed Caddy health_interval (1s) × health_fails (1) with margin.
CADDY_DRAIN_GRACE=3
INSTANCES=("a:8101" "b:8102")
FORCE_DEPLOY=0

usage() {
    cat <<EOF
Luna Connect — Zero-Downtime Deploy (blue/green via Caddy)

Usage (from repo root, as root):
  sudo ./luna-connect/deploy/deploy.sh
  sudo ./luna-connect/deploy/deploy.sh --latest-tag
  sudo ./luna-connect/deploy/deploy.sh --allow-old-tag
      Hard-reset to the newest luna-connect-v* tag, then build (safe default).

  sudo ./luna-connect/deploy/deploy.sh --head
      Hard-reset to origin/main from any starting branch, then build.

  sudo ./luna-connect/deploy/deploy.sh --no-pull
      Build current checkout without fetching (any branch).

  sudo ./luna-connect/deploy/deploy.sh --branch NAME
      Hard-reset to origin/NAME when it exists, then build.

  sudo ./luna-connect/deploy/deploy.sh --tag luna-connect-v0.2.17
      Hard-reset to that release tag (clobbers host checkout), then build.

Options:
  --force    Recovery / degraded deploy — skip preflight and peer health gates.
             When neither instance is healthy (cold start): install binary and
             start A then B sequentially — no soft drain.
             When one peer is sick: deploy anyway (may 503 briefly if stopping
             the only live instance). When both are healthy, ZDU drain still runs.
  --help     Show this help and exit.

Examples:
  sudo ./luna-connect/deploy/deploy.sh

  sudo ./luna-connect/deploy/deploy.sh --head --force

  sudo ./luna-connect/deploy/deploy.sh --no-pull

  sudo ./luna-connect/deploy/deploy.sh --tag luna-connect-v0.2.17
EOF
}

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

# --- Ref resolution (testable) -----------------------------------------------

latest_luna_connect_tag() {
    git tag --list 'luna-connect-v*' --sort=-v:refname | head -1
}

current_branch_name() {
    git symbolic-ref -q --short HEAD 2>/dev/null || echo ""
}

# stdout: head | tag:<name> | error:<reason>
# stderr: human messages for warnings
# Empty ref (no flags / --latest-tag): newest luna-connect-v* tag — safe default.
resolve_deploy_mode() {
    local ref="${1:-}"
    local _want_latest_tag="${2:-0}" # kept for callers; empty ref always means latest tag

    if [ -n "$ref" ]; then
        if [ "$ref" = "HEAD" ]; then
            echo "head"
            return 0
        fi
        echo "tag:${ref}"
        return 0
    fi

    local latest
    latest="$(latest_luna_connect_tag)"
    if [ -z "$latest" ]; then
        echo "error:no-tags"
        return 1
    fi
    local branch main_ahead=0
    branch="$(current_branch_name)"
    if [ "$branch" = "main" ]; then
        if git merge-base --is-ancestor "$latest" main 2>/dev/null \
            && [ "$(git rev-parse main)" != "$(git rev-parse "$latest"^{commit})" ]; then
            main_ahead=1
        fi
    fi
    if [ "$main_ahead" -eq 1 ]; then
        # Warnings must go to stderr — stdout is the machine-readable mode line.
        log_warn "main is ahead of latest tag ${latest} — deploying the tagged release on purpose." >&2
        log_warn "To deploy tip of main instead: sudo ./luna-connect/deploy/deploy.sh --head" >&2
    fi
    echo "tag:${latest}"
    return 0
}

warn_if_main_behind_origin() {
    if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
        return 0
    fi
    local behind
    behind="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
    if [ "${behind:-0}" -gt 0 ]; then
        log_warn "main is ${behind} commit(s) behind origin/main — deploy with --head to clobber to origin/main"
    fi
}

# Discard host dirt and make HEAD exactly match commitish (branch tip, tag, or SHA).
clobber_to_ref() {
    local ref="$1"
    local branch=""
    log_info "Clobbering checkout to ${ref} (reset --hard + clean -fd)..."
    if ! git rev-parse --verify "${ref}^{commit}" >/dev/null 2>&1; then
        log_error "Ref not found after fetch: ${ref}"
        exit 1
    fi
    case "$ref" in
        origin/*)
            # Keep a real local branch named after the remote tip (not detached HEAD).
            branch="${ref#origin/}"
            git checkout -f -B "$branch" "$ref"
            ;;
        *)
            if git show-ref --verify --quiet "refs/heads/${ref}" 2>/dev/null; then
                git checkout -f -B "$ref" "$ref"
            elif git show-ref --verify --quiet "refs/remotes/origin/${ref}" 2>/dev/null; then
                git checkout -f -B "$ref" "origin/${ref}"
            else
                # Tag or raw SHA → detached HEAD is fine for tagged deploys.
                git checkout -f "$ref"
            fi
            ;;
    esac
    git reset --hard "$ref"
    git clean -fd
    log_info "Checkout is now $(git rev-parse --short HEAD) ($(git describe --tags --always --dirty 2>/dev/null || true))"
}

checkout_main() {
    local branch
    branch="$(current_branch_name)"
    if [ "$branch" != "main" ]; then
        log_info "Checking out main..."
        git checkout -f main
    fi
}

# Fetch origin/branch and hard-reset local branch to it (clobbers local commits/dirt).
clobber_branch_from_origin() {
    local branch="$1"
    log_info "Fetching origin/${branch}..."
    if ! git fetch origin "$branch"; then
        log_error "git fetch origin ${branch} failed"
        exit 1
    fi
    if ! git rev-parse --verify "origin/${branch}" >/dev/null 2>&1; then
        log_warn "origin/${branch} not found — deploying local ${branch} checkout as-is"
        git checkout -f "$branch" 2>/dev/null || git checkout -f -B "$branch"
        git clean -fd
        return 0
    fi
    clobber_to_ref "origin/${branch}"
}

# Prepare the branch to build: hard-reset to origin (--head/--branch) unless --no-pull.
sync_head_checkout() {
    local no_pull="${1:-0}" want_main="${2:-0}" deploy_branch="${3:-}"

    if [ -n "$deploy_branch" ]; then
        if [ "$no_pull" -eq 1 ]; then
            log_info "Checking out local ${deploy_branch} (--no-pull)..."
            git checkout -f "$deploy_branch"
            git clean -fd
            return 0
        fi
        clobber_branch_from_origin "$deploy_branch"
        return 0
    fi

    if [ "$want_main" -eq 1 ]; then
        if [ "$no_pull" -eq 1 ]; then
            checkout_main
            git clean -fd
            warn_if_main_behind_origin
            return 0
        fi
        clobber_branch_from_origin "main"
        return 0
    fi

    local branch
    branch="$(current_branch_name)"
    if [ "$branch" != "main" ]; then
        return 0
    fi
    if [ "$no_pull" -eq 1 ]; then
        warn_if_main_behind_origin
        return 0
    fi
    clobber_branch_from_origin "main"
}

announce_deploy_target() {
    local mode="$1" ref_name="${2:-}"
    local short_commit full_commit branch
    short_commit="$(git rev-parse --short HEAD)"
    full_commit="$(git rev-parse HEAD)"
    case "$mode" in
        head)
            branch="$(current_branch_name)"
            if [ -n "$branch" ]; then
                log_info "Deploying ${branch} at ${short_commit} (${full_commit})"
            else
                log_info "Deploying HEAD at ${short_commit} (${full_commit})"
            fi
            ;;
        tag)
            log_info "Deploying tag ${ref_name} at ${short_commit} (${full_commit})"
            ;;
    esac
}

checkout_deploy_ref() {
    local mode="$1" ref_name="${2:-}"
    case "$mode" in
        head)
            # sync_head_checkout already clobbered to origin/branch.
            ;;
        tag)
            # Force-update the local tag from origin in case it was moved/repushed.
            log_info "Fetching tag ${ref_name} from origin (force)..."
            git fetch origin "refs/tags/${ref_name}:refs/tags/${ref_name}" --force 2>/dev/null \
                || git fetch origin tag "$ref_name" --force 2>/dev/null \
                || true
            clobber_to_ref "$ref_name"
            ;;
        *)
            log_error "Internal error: unknown deploy mode ${mode}"
            exit 1
            ;;
    esac
}

# --- Deploy runtime ----------------------------------------------------------

drain_file_for() { echo "${DATA_DIR}/drain-${1}"; }

is_healthy() { curl -sf --max-time 3 "http://127.0.0.1:${1}/healthz" >/dev/null 2>&1; }

# True when at least one instance responds healthy on /healthz.
any_instance_healthy() {
    local inst port
    for inst in "${INSTANCES[@]}"; do
        port="${inst##*:}"
        if is_healthy "$port"; then
            return 0
        fi
    done
    return 1
}

peer_of() {
    local name="$1"
    if [ "$name" = "a" ]; then
        echo "b:8102"
    else
        echo "a:8101"
    fi
}

wait_healthy() {
    local name="$1" port="$2" elapsed=0
    while ! is_healthy "$port"; do
        elapsed=$((elapsed + 1))
        if [ "$elapsed" -ge "$HEALTH_TIMEOUT" ]; then
            return 1
        fi
        sleep 1
    done
    log_info "  ${name} healthy after ${elapsed}s"
}

# Stop an instance without soft-drain (cold start / --force when peer is down).
hard_stop_instance() {
    local name="$1"
    local df
    df="$(drain_file_for "$name")"
    rm -f "$df"
    if ! systemctl is-active --quiet "luna-connect-${name}"; then
        log_info "  ${name} already stopped"
        return 0
    fi
    log_info "  Hard-stopping ${name} (no soft drain)..."
    if ! systemctl stop "luna-connect-${name}"; then
        log_error "  systemctl stop luna-connect-${name} failed"
        return 1
    fi
}

# Soft-drain: fail /healthz so Caddy drops this upstream, then stop the unit.
# Without --force, never stop an instance unless its peer is healthy (avoids site-wide 503).
drain() {
    local name="$1" port="$2"
    local peer peer_name peer_port
    peer="$(peer_of "$name")"
    peer_name="${peer%%:*}"
    peer_port="${peer##*:}"
    local df
    df="$(drain_file_for "$name")"

    if ! is_healthy "$peer_port"; then
        if [ "$FORCE_DEPLOY" -eq 1 ]; then
            if ! any_instance_healthy; then
                log_warn "  Cold start: no instance healthy — skipping soft drain for ${name}"
            else
                log_warn "  Peer ${peer_name} (:${peer_port}) not healthy — --force: deploying ${name} anyway"
            fi
            hard_stop_instance "$name"
            return $?
        fi
        log_error "  Peer ${peer_name} (:${peer_port}) is not healthy — refusing to drain ${name} (would 503 the site)"
        return 1
    fi

    if ! systemctl is-active --quiet "luna-connect-${name}"; then
        log_info "  ${name} already stopped — skipping drain"
        rm -f "$df"
        return 0
    fi

    log_info "  Soft-draining ${name} (Caddy must drop it before stop)..."
    mkdir -p "$DATA_DIR"
    touch "$df"

    local elapsed=0 soft_ok=0
    while [ "$elapsed" -lt 15 ]; do
        if ! is_healthy "$port"; then
            soft_ok=1
            break
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done

    if [ "$soft_ok" -eq 1 ]; then
        log_info "  ${name} /healthz draining after ${elapsed}s — waiting ${CADDY_DRAIN_GRACE}s for Caddy"
        sleep "$CADDY_DRAIN_GRACE"
    else
        log_warn "  Soft drain ignored after ${elapsed}s (old binary without drain file support?)"
        log_warn "  Falling back to hard stop — brief 502/503 blip possible until Caddy notices"
    fi

    if ! systemctl stop "luna-connect-${name}"; then
        rm -f "$df"
        log_error "  systemctl stop luna-connect-${name} failed"
        return 1
    fi
    # Clear drain marker before restart so the new process reports healthy.
    rm -f "$df"
}

build_binary() {
    log_step "Building Luna Connect"
    cd "$REPO_ROOT/luna-connect"
    log_info "  Building web UI..."
    (cd web && npm install --silent && npm run build)
    git_commit=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
    build_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    go build \
        -ldflags "-X main.version=$(git -C "$REPO_ROOT" describe --tags --always 2>/dev/null || echo dev) \
                  -X main.gitCommit=$git_commit \
                  -X main.buildTime=$build_time" \
        -o "/tmp/${BINARY_NAME}-new" ./cmd/server
    mkdir -p "${INSTALL_DIR}/web"
    cp -a "$REPO_ROOT/luna-connect/web/dist/." "${INSTALL_DIR}/web/"
    log_info "  Build complete"
}

deploy_instance() {
    local name="$1" port="$2" svc="luna-connect-${name}"
    log_step "Deploying instance ${name} (port ${port})"
    if ! drain "$name" "$port"; then
        return 1
    fi
    cp "/tmp/${BINARY_NAME}-new" "${INSTALL_DIR}/${BINARY_NAME}.new"
    chmod +x "${INSTALL_DIR}/${BINARY_NAME}.new"
    if [ -f "${INSTALL_DIR}/${BINARY_NAME}" ]; then
        cp "${INSTALL_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}.bak"
    fi
    mv "${INSTALL_DIR}/${BINARY_NAME}.new" "${INSTALL_DIR}/${BINARY_NAME}"
    # Ensure drain file is gone (also cleared in drain; belt-and-suspenders).
    rm -f "$(drain_file_for "$name")"
    systemctl start "$svc"
    if ! wait_healthy "$name" "$port"; then
        log_error "  ${name} failed health — rolling back"
        cp "${INSTALL_DIR}/${BINARY_NAME}.bak" "${INSTALL_DIR}/${BINARY_NAME}"
        rm -f "$(drain_file_for "$name")"
        systemctl start "$svc"
        sleep 2
        if is_healthy "$port"; then
            log_warn "  ${name} rolled back (healthy)"
        else
            log_error "  ${name} rollback failed — journalctl -u ${svc}"
        fi
        return 1
    fi
    # Give Caddy one interval to put this upstream back before draining the peer.
    sleep "$CADDY_DRAIN_GRACE"
    log_info "  ${name} deployed"
}

require_root() {
    if [ "${EUID:-$(id -u)}" -ne 0 ]; then
        log_error "Run as root so systemctl can stop/start instances: sudo $0 $*"
        exit 1
    fi
}

preflight() {
    log_step "Preflight: both instances must be healthy"
    local unhealthy=0
    for inst in "${INSTANCES[@]}"; do
        local name="${inst%%:*}" port="${inst##*:}"
        if ! systemctl cat "luna-connect-${name}" >/dev/null 2>&1; then
            log_error "systemd luna-connect-${name} missing. Run: sudo bash luna-connect/deploy/setup.sh"
            exit 1
        fi
        if ! systemctl is-active --quiet "luna-connect-${name}"; then
            log_error "  luna-connect-${name} is not active ($(systemctl is-active "luna-connect-${name}"))"
            unhealthy=1
            continue
        fi
        if ! is_healthy "$port"; then
            log_error "  luna-connect-${name} is up but /healthz on :${port} failed"
            unhealthy=1
            continue
        fi
        log_info "  ${name} healthy on :${port}"
    done
    if [ "$unhealthy" -ne 0 ]; then
        if [ "$FORCE_DEPLOY" -eq 1 ]; then
            if ! any_instance_healthy; then
                log_warn "Preflight failed but --force set — cold start (both instances down)."
                log_warn "Will install binary and start A, then B, without ZDU soft drain."
            else
                log_warn "Preflight failed but --force set — continuing with degraded deploy."
                log_warn "Peer health checks skipped when draining; brief outage possible."
            fi
            return 0
        fi
        log_error "Fix the unhealthy instance first (journalctl -u luna-connect-a -u luna-connect-b)."
        log_error "Draining the only live instance is what produces site-wide 503."
        log_error "If one peer is healthy and you accept the risk: sudo $0 ... --force"
        exit 1
    fi

    if ! grep -q 'localhost:8101' /etc/caddy/Caddyfile 2>/dev/null || ! grep -q 'localhost:8102' /etc/caddy/Caddyfile 2>/dev/null; then
        log_warn "Caddyfile may not list both :8101 and :8102 — ZDU cannot work with a single upstream."
        log_warn "Merge luna-connect/deploy/Caddyfile.conf into /etc/caddy/Caddyfile and reload Caddy."
    fi
}

main() {
    require_root "$@"

    local ref="" want_latest_tag=0 no_pull=0 want_main=0 deploy_branch=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --help|-h)
                usage
                exit 0
                ;;
            --force)
                FORCE_DEPLOY=1
                shift
                ;;
            --head)
                ref="HEAD"
                want_main=1
                shift
                ;;
            --no-pull)
                ref="HEAD"
                no_pull=1
                shift
                ;;
            --branch)
                if [ -z "${2:-}" ]; then
                    log_error "--branch requires a branch name"
                    exit 1
                fi
                ref="HEAD"
                deploy_branch="$2"
                shift 2
                ;;
            --tag)
                if [ -z "${2:-}" ]; then
                    log_error "--tag requires a tag name"
                    exit 1
                fi
                ref="$2"
                shift 2
                ;;
            --latest-tag|--allow-old-tag)
                want_latest_tag=1
                shift
                ;;
            *)
                log_error "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done

    log_step "Luna Connect — Zero-Downtime Deploy"
    cd "$REPO_ROOT"

    # Default (no flags) and explicit tag modes: always force-refresh release tags.
    # Host tags often diverge from origin; plain fetch refuses to clobber under set -e.
    if [ -z "$ref" ] || [ "$want_latest_tag" -eq 1 ] || { [ -n "$ref" ] && [ "$ref" != "HEAD" ]; }; then
        log_info "Fetching luna-connect-v* tags from origin (force)..."
        if ! git fetch origin --force 'refs/tags/luna-connect-v*:refs/tags/luna-connect-v*'; then
            log_error "Failed to fetch luna-connect-v* tags from origin"
            exit 1
        fi
    fi

    local resolved mode tag_name resolve_rc=0
    # Keep stdout even when resolve_deploy_mode returns non-zero (error:no-tags).
    resolved="$(resolve_deploy_mode "$ref" "$want_latest_tag")" || resolve_rc=$?

    case "$resolved" in
        head)
            mode="head"
            sync_head_checkout "$no_pull" "$want_main" "$deploy_branch"
            checkout_deploy_ref "$mode"
            announce_deploy_target "$mode"
            ;;
        tag:*)
            mode="tag"
            tag_name="${resolved#tag:}"
            if ! git rev-parse --verify "${tag_name}^{commit}" >/dev/null 2>&1; then
                log_error "Tag not found: ${tag_name}"
                exit 1
            fi
            checkout_deploy_ref "$mode" "$tag_name"
            announce_deploy_target "$mode" "$tag_name"
            ;;
        error:no-tags)
            log_error "No luna-connect-v* tags after fetching from origin."
            log_info "Create one: git tag luna-connect-v0.1.0 && git push --tags"
            log_info "Or deploy tip of main: sudo ./luna-connect/deploy/deploy.sh --head"
            log_info "Or deploy this checkout: sudo ./luna-connect/deploy/deploy.sh --no-pull"
            exit 1
            ;;
        *)
            log_error "Could not resolve deploy ref (got: ${resolved:-<empty>}, rc=${resolve_rc})."
            log_info "Try: sudo ./luna-connect/deploy/deploy.sh --head"
            exit 1
            ;;
    esac

    preflight
    build_binary

    if [ "$FORCE_DEPLOY" -eq 1 ] && ! any_instance_healthy; then
        log_warn "Cold start mode: neither instance is healthy — sequential start (A, then B)."
    fi

    for inst in "${INSTANCES[@]}"; do
        name="${inst%%:*}"
        port="${inst##*:}"
        if ! deploy_instance "$name" "$port"; then
            log_error "Failed at ${name}. The other instance should still be serving."
            rm -f "/tmp/${BINARY_NAME}-new"
            exit 1
        fi
    done
    rm -f "/tmp/${BINARY_NAME}-new"
    log_step "Deployment complete"
    echo "  A: http://127.0.0.1:8101  ($(systemctl is-active luna-connect-a))"
    echo "  B: http://127.0.0.1:8102  ($(systemctl is-active luna-connect-b))"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
