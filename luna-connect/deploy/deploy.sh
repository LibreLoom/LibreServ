#!/bin/bash
set -euo pipefail

# Luna Connect — Zero-Downtime Deploy (blue/green via Caddy).
#
# Two instances (A :8101, B :8102) share one SQLite file + object store.
# Caddy health-checks /healthz. This script drains one instance at a time.
#
# Usage (from repo root):
#   ./luna-connect/deploy/deploy.sh
#   ./luna-connect/deploy/deploy.sh --tag luna-connect-v0.1.0
#   ./luna-connect/deploy/deploy.sh --head

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="/opt/luna-connect"
BINARY_NAME="luna-connect"
HEALTH_TIMEOUT=30
DRAIN_WAIT=2
INSTANCES=("a:8101" "b:8102")

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

is_healthy() { curl -sf --max-time 3 "http://localhost:${1}/healthz" >/dev/null 2>&1; }

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

drain() {
    log_info "  Draining ${1}..."
    systemctl stop "luna-connect-${1}" 2>/dev/null || true
    sleep "$DRAIN_WAIT"
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
    drain "$name"
    cp "/tmp/${BINARY_NAME}-new" "${INSTALL_DIR}/${BINARY_NAME}.new"
    chmod +x "${INSTALL_DIR}/${BINARY_NAME}.new"
    if [ -f "${INSTALL_DIR}/${BINARY_NAME}" ]; then
        cp "${INSTALL_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}.bak"
    fi
    mv "${INSTALL_DIR}/${BINARY_NAME}.new" "${INSTALL_DIR}/${BINARY_NAME}"
    systemctl start "$svc"
    if ! wait_healthy "$name" "$port"; then
        log_error "  ${name} failed health — rolling back"
        cp "${INSTALL_DIR}/${BINARY_NAME}.bak" "${INSTALL_DIR}/${BINARY_NAME}"
        systemctl start "$svc"
        sleep 2
        if is_healthy "$port"; then
            log_warn "  ${name} rolled back (healthy)"
        else
            log_error "  ${name} rollback failed — journalctl -u ${svc}"
        fi
        return 1
    fi
    log_info "  ${name} deployed"
}

main() {
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
                log_info "Or deploy this checkout: ./luna-connect/deploy/deploy.sh --head"
                exit 1
            fi
        fi
        log_info "Deploying ${ref}"
        git checkout -f "$ref"
        git clean -fd luna-connect/web/ >/dev/null 2>&1 || true
    fi

    for inst in "${INSTANCES[@]}"; do
        name="${inst%%:*}"
        if ! systemctl cat "luna-connect-${name}" >/dev/null 2>&1; then
            log_error "systemd luna-connect-${name} missing. Run luna-connect/deploy/setup.sh first."
            exit 1
        fi
    done

    build_binary

    for inst in "${INSTANCES[@]}"; do
        name="${inst%%:*}"
        port="${inst##*:}"
        if ! deploy_instance "$name" "$port"; then
            log_error "Failed at ${name}. The other instance is still serving."
            rm -f "/tmp/${BINARY_NAME}-new"
            exit 1
        fi
    done
    rm -f "/tmp/${BINARY_NAME}-new"
    log_step "Deployment complete"
    echo "  A: http://localhost:8101  ($(systemctl is-active luna-connect-a))"
    echo "  B: http://localhost:8102  ($(systemctl is-active luna-connect-b))"
}

main "$@"
