#!/bin/bash
set -euo pipefail

# LibreServ Connect — Zero-Downtime Deploy
#
# Blue/green deployment via Caddy reverse proxy with active health checks.
# Two Connect instances (A on :8091, B on :8092) share one Postgres database.
# Caddy load-balances across both; deploy drains one at a time.
#
# Usage:
#   ./connect/deploy/deploy.sh                   # deploy latest connect-v* tag (default)
#   ./connect/deploy/deploy.sh --tag connect-v1.2.3  # deploy a specific tag
#   ./connect/deploy/deploy.sh --head            # deploy current HEAD (dev escape hatch)
#
# The server is a deploy target: deploys force-checkout the ref and discard
# any local modifications (including stray web dist/ output).
#
# Prerequisites:
#   - Caddy installed and configured with connect/deploy/Caddyfile.conf
#   - Postgres running with libreserv_connect database
#   - systemd services connect-a.service and connect-b.service installed
#   - This script run from the LibreServ repo root

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="/opt/libreserv-connect"
CONFIG_DIR="/etc/libreserv-connect"
BINARY_NAME="connect-server"
HEALTH_TIMEOUT=30   # seconds to wait for instance to become healthy
DRAIN_WAIT=2        # seconds to let in-flight requests complete after stop

# Instances: name → port
INSTANCES=("a:8091" "b:8092")

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

# Check if an instance is healthy
is_healthy() {
    local port="$1"
    curl -sf --max-time 3 "http://localhost:${port}/healthz" >/dev/null 2>&1
}

# Wait for an instance to become healthy
wait_healthy() {
    local name="$1"
    local port="$2"
    local elapsed=0
    while ! is_healthy "$port"; do
        elapsed=$((elapsed + 1))
        if [ "$elapsed" -ge "$HEALTH_TIMEOUT" ]; then
            return 1
        fi
        sleep 1
    done
    log_info "  ${name} healthy after ${elapsed}s"
    return 0
}

# Drain an instance: stop it, wait for in-flight requests
drain() {
    local name="$1"
    log_info "  Draining ${name} (stopping service)..."
    systemctl stop "connect-${name}" 2>/dev/null || true
    sleep "$DRAIN_WAIT"
}

# Build the binary
build_binary() {
    log_step "Building Connect binary"

    cd "$REPO_ROOT/connect"

    # Build web UIs
    log_info "  Building admin UI..."
    (cd web/admin && npm install --silent && npm run build)

    log_info "  Building customer UI..."
    (cd web/customer && npm install --silent && npm run build)

    # Build binary
    log_info "  Building connect-server..."
    local git_commit
    git_commit=$(git rev-parse --short HEAD)
    local build_time
    build_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    go build \
        -ldflags "-X main.version=$(git describe --tags --always 2>/dev/null || echo dev) \
                  -X main.gitCommit=$git_commit \
                  -X main.buildTime=$build_time" \
        -o "/tmp/${BINARY_NAME}-new" ./cmd/server

    cd "$REPO_ROOT"

    # Copy built web UIs to the install directory.
    # The Go binary serves these as static files; they must be updated
    # alongside the binary or the browser loads stale JS bundles.
    log_info "  Copying web UIs to ${INSTALL_DIR}/web/..."
    mkdir -p "${INSTALL_DIR}/web/admin" "${INSTALL_DIR}/web/customer"
    cp -a "$REPO_ROOT/connect/web/admin/dist/." "${INSTALL_DIR}/web/admin/"
    cp -a "$REPO_ROOT/connect/web/customer/dist/." "${INSTALL_DIR}/web/customer/"

    log_info "  Build complete"
}

# Deploy to a single instance: drain, swap binary, restart, health-check
deploy_instance() {
    local name="$1"
    local port="$2"
    local svc="connect-${name}"

    log_step "Deploying instance ${name} (port ${port})"

    # Drain
    drain "$name"

    # Swap binary
    log_info "  Swapping binary..."
    cp "/tmp/${BINARY_NAME}-new" "${INSTALL_DIR}/${BINARY_NAME}.new"
    chmod +x "${INSTALL_DIR}/${BINARY_NAME}.new"

    # Backup current, swap
    if [ -f "${INSTALL_DIR}/${BINARY_NAME}" ]; then
        cp "${INSTALL_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}.bak"
    fi
    mv "${INSTALL_DIR}/${BINARY_NAME}.new" "${INSTALL_DIR}/${BINARY_NAME}"

    # Restart
    log_info "  Starting ${svc}..."
    systemctl start "$svc"

    # Health check
    if ! wait_healthy "$name" "$port"; then
        log_error "  ${name} failed to become healthy — rolling back"
        cp "${INSTALL_DIR}/${BINARY_NAME}.bak" "${INSTALL_DIR}/${BINARY_NAME}"
        systemctl start "$svc"
        sleep 2
        if is_healthy "$port"; then
            log_warn "  ${name} rolled back to previous binary (healthy)"
        else
            log_error "  ${name} rollback also failed — check journalctl -u ${svc}"
        fi
        return 1
    fi

    log_info "  ${name} deployed successfully"
    return 0
}

# Main
main() {
    log_step "LibreServ Connect — Zero-Downtime Deploy"

    # Resolve which ref to deploy. The server is a deploy target, not a dev
    # machine — it should never carry local modifications. Default is the
    # latest connect-v* tag; --head deploys whatever is checked out.
    local ref=""
    cd "$REPO_ROOT"
    git fetch --tags

    if [ "${1:-}" = "--head" ]; then
        ref="HEAD"
        log_info "Deploying current HEAD ($(git rev-parse --short HEAD))"
    else
        if [ "${1:-}" = "--tag" ] && [ -n "${2:-}" ]; then
            ref="$2"
        else
            ref=$(git describe --tags --match 'connect-v*' --abbrev=0 2>/dev/null || true)
            if [ -z "$ref" ]; then
                log_error "No connect-v* tags found. Create one: git tag connect-v0.1.0 && git push --tags"
                exit 1
            fi
        fi
        log_info "Deploying ${ref}"
    fi

    # Force the checkout: discard any local modifications and remove stray
    # build outputs (web dist/) that would otherwise block the checkout.
    # This is intentional — the deploy box must always match the ref exactly.
    git checkout -f "$ref"
    git clean -fd connect/web/ >/dev/null 2>&1 || true

    # Pre-flight checks
    for inst in "${INSTANCES[@]}"; do
        local name="${inst%%:*}"
        local svc="connect-${name}"
        if ! systemctl cat "$svc" >/dev/null 2>&1; then
            log_error "Systemd service ${svc} not found. Run connect/deploy/setup.sh first."
            exit 1
        fi
    done

    # Build
    build_binary

    # Deploy one instance at a time
    for inst in "${INSTANCES[@]}"; do
        local name="${inst%%:*}"
        local port="${inst##*:}"

        if ! deploy_instance "$name" "$port"; then
            log_error "Deployment failed at instance ${name}. The other instance is still running."
            log_error "Fix the issue and re-run this script."
            rm -f "/tmp/${BINARY_NAME}-new"
            exit 1
        fi
    done

    rm -f "/tmp/${BINARY_NAME}-new"

    log_step "Deployment complete"
    log_info "Both instances are healthy and serving traffic via Caddy."
    echo ""
    echo "  Instance A: http://localhost:8091  ($(systemctl is-active connect-a))"
    echo "  Instance B: http://localhost:8092  ($(systemctl is-active connect-b))"
    echo ""
    echo "  Caddy is load-balancing across both. Zero downtime achieved."
}

main "$@"
