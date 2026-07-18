#!/bin/bash
set -euo pipefail

# LibreServ Connect — Initial Server Setup
#
# Sets up two Connect instances (A + B) for blue/green ZDU behind Caddy.
# Run once on the server. Idempotent — safe to re-run.
#
# Usage: sudo bash connect/deploy/setup.sh
#
# Prerequisites:
#   - Caddy installed
#   - PostgreSQL installed and running
#   - Git repo cloned to the server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

INSTALL_DIR="/opt/libreserv-connect"
CONFIG_DIR="/etc/libreserv-connect"
DATA_DIR="/var/lib/libreserv-connect"
LOG_DIR="/var/log/libreserv-connect"
USER="libreserv-connect"

# Instance config: name:port
INSTANCES=("a:8091" "b:8092")

# Postgres
PG_DB="libreserv_connect"
PG_USER="libreserv_connect"
PG_HOST="localhost"
PG_PORT="5432"
BASE_URL="${BASE_URL:-}"

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

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "This script must be run as root"
        exit 1
    fi
}

check_prerequisites() {
    log_step "Checking prerequisites"

    if ! command -v caddy &>/dev/null; then
        log_error "Caddy is not installed. Install it first: https://caddyserver.com/docs/install"
        exit 1
    fi

    if ! command -v psql &>/dev/null; then
        log_error "PostgreSQL is not installed. Install it first."
        exit 1
    fi

    if ! systemctl is-active --quiet postgresql; then
        log_error "PostgreSQL is not running. Start it: systemctl start postgresql"
        exit 1
    fi

    log_info "Prerequisites OK"
}

create_user() {
    if id "$USER" &>/dev/null; then
        log_info "User '$USER' already exists"
    else
        log_info "Creating user '$USER'..."
        useradd --system --no-create-home --shell /usr/sbin/nologin "$USER"
    fi
}

create_directories() {
    log_info "Creating directories..."
    mkdir -p "$INSTALL_DIR/web/admin"
    mkdir -p "$INSTALL_DIR/web/customer"
    mkdir -p "$CONFIG_DIR"
    mkdir -p "$DATA_DIR"
    mkdir -p "$LOG_DIR"
    chown -R "$USER:$USER" "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"
}

setup_postgres() {
    log_step "Setting up PostgreSQL"

    # Create database user (idempotent)
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1; then
        log_info "Creating Postgres user '$PG_USER'..."
        sudo -u postgres psql -c "CREATE USER $PG_USER WITH PASSWORD 'CHANGE_ME_PASSWORD';"
        log_warn "Postgres password is 'CHANGE_ME_PASSWORD' — change it in the config files!"
    else
        log_info "Postgres user '$PG_USER' already exists"
    fi

    # Create database (idempotent)
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1; then
        log_info "Creating Postgres database '$PG_DB'..."
        sudo -u postgres psql -c "CREATE DATABASE $PG_DB OWNER $PG_USER;"
    else
        log_info "Postgres database '$PG_DB' already exists"
    fi

    # Grant privileges
    sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $PG_DB TO $PG_USER;" >/dev/null
    log_info "PostgreSQL ready"
}

create_configs() {
    log_step "Creating instance configs"

    for inst in "${INSTANCES[@]}"; do
        local name="${inst%%:*}"
        local port="${inst##*:}"
        local config_file="$CONFIG_DIR/connect-${name}.yaml"

        if [ -f "$config_file" ]; then
            log_info "  Config for instance ${name} already exists ($config_file)"
            continue
        fi

        log_info "  Creating config for instance ${name} (port ${port})..."

        # Generate random secrets
        local device_secret admin_secret customer_secret
        device_secret=$(openssl rand -hex 32)
        admin_secret=$(openssl rand -hex 32)
        customer_secret=$(openssl rand -hex 32)

        cat > "$config_file" <<EOF
server:
    address: "127.0.0.1"
    port: ${port}
    base_url: "${BASE_URL}"

database:
    url: "postgres://${PG_USER}:CHANGE_ME_PASSWORD@${PG_HOST}:${PG_PORT}/${PG_DB}?sslmode=disable"

auth:
    device_token_secret: ${device_secret}
    admin_token_secret: ${admin_secret}
    customer_token_secret: ${customer_secret}
    session_ttl_hours: 168

polar:
    enabled: false
    access_token: ""
    webhook_secret: ""
    sandbox: true
    product_free: ""
    product_lite: ""
    product_one: ""

web:
    customer_dir: ${INSTALL_DIR}/web/customer
    admin_dir: ${INSTALL_DIR}/web/admin
EOF
        chown "$USER:$USER" "$config_file"
        chmod 640 "$config_file"
    done

    log_warn "Remember to change CHANGE_ME_PASSWORD in each config file to your Postgres password."
}

create_systemd_services() {
    log_step "Creating systemd services"

    local template="$SCRIPT_DIR/connect-instance.service.tmpl"

    for inst in "${INSTANCES[@]}"; do
        local name="${inst%%:*}"
        local svc_file="/etc/systemd/system/connect-${name}.service"

        log_info "  Creating connect-${name}.service..."
        sed "s/{INSTANCE}/${name}/g" "$template" > "$svc_file"
    done

    systemctl daemon-reload
    log_info "Systemd services created"
}

build_and_install() {
    log_step "Building and installing Connect"

    # Build web UIs
    log_info "  Building admin UI..."
    (cd "$REPO_ROOT/connect/web/admin" && npm install --silent && npm run build)

    log_info "  Building customer UI..."
    (cd "$REPO_ROOT/connect/web/customer" && npm install --silent && npm run build)

    # Build binary
    log_info "  Building connect-server..."
    local git_commit build_time
    git_commit=$(cd "$REPO_ROOT" && git rev-parse --short HEAD)
    build_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    (cd "$REPO_ROOT/connect" && go build \
        -ldflags "-X main.version=$(git describe --tags --always 2>/dev/null || echo dev) \
                  -X main.gitCommit=$git_commit \
                  -X main.buildTime=$build_time" \
        -o "$INSTALL_DIR/connect-server" ./cmd/server)

    # Install web dists
    rm -rf "$INSTALL_DIR/web/admin" "$INSTALL_DIR/web/customer"
    cp -r "$REPO_ROOT/connect/web/admin/dist" "$INSTALL_DIR/web/admin"
    cp -r "$REPO_ROOT/connect/web/customer/dist" "$INSTALL_DIR/web/customer"

    chown -R "$USER:$USER" "$INSTALL_DIR"
    log_info "Build and install complete"
}

start_services() {
    log_step "Starting services"

    for inst in "${INSTANCES[@]}"; do
        local name="${inst%%:*}"
        local port="${inst##*:}"
        local svc="connect-${name}"

        log_info "  Enabling and starting ${svc}..."
        systemctl enable "$svc"
        systemctl start "$svc"

        # Wait for health
        local elapsed=0
        while ! curl -sf --max-time 3 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; do
            elapsed=$((elapsed + 1))
            if [ "$elapsed" -ge 30 ]; then
                log_error "  ${svc} failed to start — check: journalctl -u ${svc}"
                exit 1
            fi
            sleep 1
        done
        log_info "  ${svc} healthy (port ${port})"
    done
}

print_caddy_instructions() {
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  LibreServ Connect installed — blue/green ZDU ready${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Two instances running:"
    echo "    connect-a  →  127.0.0.1:8091  ($(systemctl is-active connect-a))"
    echo "    connect-b  →  127.0.0.1:8092  ($(systemctl is-active connect-b))"
    echo ""
    echo -e "${YELLOW}  Next: add Connect to your Caddyfile${NC}"
    echo "  Copy the snippet from: connect/deploy/Caddyfile.conf"
    echo "  Replace connect.example.com with your domain, then:"
    echo "    caddy reload --config /etc/caddy/Caddyfile"
    echo ""
    echo "  Deploy updates (zero downtime):"
    echo "    cd $REPO_ROOT && ./connect/deploy/deploy.sh"
    echo ""
    echo "  If using --tag:"
    echo "    ./connect/deploy/deploy.sh --tag vX.Y.Z"
    echo ""
    echo -e "${YELLOW}  IMPORTANT:${NC} Change CHANGE_ME_PASSWORD in:"
    echo "    $CONFIG_DIR/connect-a.yaml"
    echo "    $CONFIG_DIR/connect-b.yaml"
    echo "  Then restart both services:"
    echo "    systemctl restart connect-a connect-b"
    echo ""
}

# Main
main() {
    check_root
    check_prerequisites
    create_user
    create_directories
    setup_postgres
    create_configs
    create_systemd_services
    build_and_install
    start_services
    print_caddy_instructions
}

main
