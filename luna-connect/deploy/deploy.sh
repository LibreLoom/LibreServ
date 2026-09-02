#!/bin/bash
set -euo pipefail

# Luna Connect — Zero-Downtime Deploy (blue/green via Caddy).
#
# Two instances (A :8101, B :8102) share one SQLite file + object store.
# Caddy health-checks /healthz. This script soft-drains one instance at a
# time (touch drain file → /healthz 503 → wait for Caddy to drop it → stop).
#
# IMPORTANT — what gets deployed:
#   On main with no flags: deploys your current main checkout (same as --head).
#   Off main with no flags: refuses (prevents accidental tag deploys / detached HEAD).
#   Use --tag or --latest-tag only when you intentionally want a tagged release.
#
# Typical production update (from repo root, as root):
#   git checkout main && git pull origin main
#   sudo ./luna-connect/deploy/deploy.sh
#   # or explicitly:
#   sudo ./luna-connect/deploy/deploy.sh --head
#   sudo ./luna-connect/deploy/deploy.sh --head --force   # one instance already sick
#
# Tagged release (when main has moved past the tag):
#   sudo ./luna-connect/deploy/deploy.sh --tag luna-connect-v0.2.17
#   sudo ./luna-connect/deploy/deploy.sh --latest-tag       # newest luna-connect-v* tag
#   sudo ./luna-connect/deploy/deploy.sh --allow-old-tag    # alias for --latest-tag

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
      On main: deploy current checkout (recommended after git pull).
      Off main: error — use --head or --tag explicitly.

  sudo ./luna-connect/deploy/deploy.sh --head
      Deploy current checkout (any branch).

  sudo ./luna-connect/deploy/deploy.sh --tag luna-connect-v0.2.17
      Deploy a specific release tag.

  sudo ./luna-connect/deploy/deploy.sh --latest-tag
  sudo ./luna-connect/deploy/deploy.sh --allow-old-tag
      Deploy the newest luna-connect-v* tag (even when main is ahead).

Options:
  --force    Skip preflight that requires both instances healthy.
             Use when one instance is already broken but its peer is healthy.
             Drain still refuses to stop the only live instance (no site-wide 503).
  --help     Show this help and exit.

Examples:
  git checkout main && git pull origin main
  sudo ./luna-connect/deploy/deploy.sh

  git checkout main && git pull origin main
  sudo ./luna-connect/deploy/deploy.sh --head --force

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
resolve_deploy_mode() {
    local ref="${1:-}"
    local want_latest_tag="${2:-0}"

    if [ -n "$ref" ]; then
        if [ "$ref" = "HEAD" ]; then
            echo "head"
            return 0
        fi
        echo "tag:${ref}"
        return 0
    fi

    if [ "$want_latest_tag" -eq 1 ]; then
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
            log_warn "main is ahead of latest tag ${latest} — you are deploying the older tag on purpose."
            log_warn "To deploy current main instead: sudo ./luna-connect/deploy/deploy.sh --head"
        fi
        echo "tag:${latest}"
        return 0
    fi

    local branch
    branch="$(current_branch_name)"
    if [ "$branch" = "main" ]; then
        echo "head"
        return 0
    fi

    echo "error:not-on-main"
    return 1
}

warn_if_main_behind_origin() {
    if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
        return 0
    fi
    local behind
    behind="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
    if [ "${behind:-0}" -gt 0 ]; then
        log_warn "main is ${behind} commit(s) behind origin/main — run: git pull origin main"
    fi
}

announce_deploy_target() {
    local mode="$1" ref_name="${2:-}"
    local short_commit branch
    short_commit="$(git rev-parse --short HEAD)"
    case "$mode" in
        head)
            branch="$(current_branch_name)"
            if [ -n "$branch" ]; then
                log_info "Deploying ${branch} at commit ${short_commit}"
            else
                log_info "Deploying HEAD at commit ${short_commit}"
            fi
            ;;
        tag)
            log_info "Deploying tag ${ref_name} at commit ${short_commit}"
            ;;
    esac
}

checkout_deploy_ref() {
    local mode="$1" ref_name="${2:-}"
    case "$mode" in
        head)
            # Stay on current checkout; no checkout needed.
            ;;
        tag)
            git checkout -f "$ref_name"
            git clean -fd luna-connect/web/ >/dev/null 2>&1 || true
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

# Soft-drain: fail /healthz so Caddy drops this upstream, then stop the unit.
# Never stop an instance unless its peer is healthy (avoids site-wide 503).
drain() {
    local name="$1" port="$2"
    local peer peer_name peer_port
    peer="$(peer_of "$name")"
    peer_name="${peer%%:*}"
    peer_port="${peer##*:}"
    local df
    df="$(drain_file_for "$name")"

    if ! is_healthy "$peer_port"; then
        log_error "  Peer ${peer_name} (:${peer_port}) is not healthy — refusing to drain ${name} (would 503 the site)"
        return 1
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
            log_warn "Preflight failed but --force set — continuing (peer must stay healthy during each drain)."
            log_warn "If only one instance serves traffic, deploy fixes the sick one first (A, then B)."
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

    local ref="" want_latest_tag=0
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
                shift
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
    git fetch --tags --force

    local resolved mode tag_name
    if ! resolved="$(resolve_deploy_mode "$ref" "$want_latest_tag")"; then
        resolved=""
    fi

    case "$resolved" in
        head)
            mode="head"
            warn_if_main_behind_origin
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
            log_error "No luna-connect-v* tags. Create one: git tag luna-connect-v0.1.0 && git push --tags"
            log_info "Or deploy this checkout: sudo ./luna-connect/deploy/deploy.sh --head"
            exit 1
            ;;
        error:not-on-main)
            log_error "Not on main ($(current_branch_name || echo 'detached HEAD'))."
            log_error "Bare ./luna-connect/deploy/deploy.sh only deploys main."
            log_error "  sudo ./luna-connect/deploy/deploy.sh --head          # current checkout"
            log_error "  sudo ./luna-connect/deploy/deploy.sh --tag NAME      # specific release"
            log_error "  sudo ./luna-connect/deploy/deploy.sh --latest-tag    # newest luna-connect-v* tag"
            exit 1
            ;;
        *)
            log_error "Could not resolve deploy ref."
            exit 1
            ;;
    esac

    preflight
    build_binary

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
