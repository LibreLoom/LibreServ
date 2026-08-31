#!/bin/bash
set -euo pipefail

# Luna Connect — Zero-Downtime Deploy (blue/green via Caddy).
#
# Two instances (A :8101, B :8102) share one SQLite file + object store.
# Caddy health-checks /healthz. This script soft-drains one instance at a
# time (touch drain file → /healthz 503 → wait for Caddy to drop it → stop).
#
# Usage (from repo root, as root):
#   sudo ./luna-connect/deploy/deploy.sh
#   sudo ./luna-connect/deploy/deploy.sh --tag luna-connect-v0.1.0
#   sudo ./luna-connect/deploy/deploy.sh --head

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="/opt/luna-connect"
DATA_DIR="/var/lib/luna-connect"
BINARY_NAME="luna-connect"
HEALTH_TIMEOUT=30
# Must exceed Caddy health_interval (1s) × health_fails (1) with margin.
CADDY_DRAIN_GRACE=3
INSTANCES=("a:8101" "b:8102")

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

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
        log_error "Fix the unhealthy instance first (journalctl -u luna-connect-a -u luna-connect-b)."
        log_error "Draining the only live instance is what produces site-wide 503."
        exit 1
    fi

    if ! grep -q 'localhost:8101' /etc/caddy/Caddyfile 2>/dev/null || ! grep -q 'localhost:8102' /etc/caddy/Caddyfile 2>/dev/null; then
        log_warn "Caddyfile may not list both :8101 and :8102 — ZDU cannot work with a single upstream."
        log_warn "Merge luna-connect/deploy/Caddyfile.conf into /etc/caddy/Caddyfile and reload Caddy."
    fi
}

main() {
    require_root "$@"
    log_step "Luna Connect — Zero-Downtime Deploy"
    cd "$REPO_ROOT"
    git fetch --tags --force

    local ref=""
    if [ "${1:-}" = "--head" ]; then
        ref="HEAD"
        log_info "Deploying HEAD ($(git rev-parse --short HEAD))"
    else
        if [ "${1:-}" = "--tag" ] && [ -n "${2:-}" ]; then
            ref="$2"
        else
            ref=$(git tag --list 'luna-connect-v*' --sort=-v:refname | head -1)
            if [ -z "$ref" ]; then
                log_error "No luna-connect-v* tags. Create one: git tag luna-connect-v0.1.0 && git push --tags"
                log_info "Or deploy this checkout: sudo ./luna-connect/deploy/deploy.sh --head"
                exit 1
            fi
        fi
        log_info "Deploying ${ref}"
        git checkout -f "$ref"
        git clean -fd luna-connect/web/ >/dev/null 2>&1 || true
    fi

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

main "$@"
