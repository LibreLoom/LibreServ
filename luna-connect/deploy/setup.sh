#!/bin/bash
set -euo pipefail

# Luna Connect — initial server setup (blue/green ZDU behind Caddy).
# Idempotent. Usage: sudo bash luna-connect/deploy/setup.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

INSTALL_DIR="/opt/luna-connect"
CONFIG_DIR="/etc/luna-connect"
DATA_DIR="/var/lib/luna-connect"
LOG_DIR="/var/log/luna-connect"
USER="luna-connect"
INSTANCES=("a:8101" "b:8102")
BASE_URL="${BASE_URL:-https://connect.luna.libreloom.org}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

if [ "$EUID" -ne 0 ]; then
    log_error "This script must be run as root"
    exit 1
fi

if ! command -v caddy &>/dev/null; then
    log_error "Caddy is not installed."
    exit 1
fi

if ! id "$USER" &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$USER"
fi

mkdir -p "$INSTALL_DIR/web" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"
chown -R "$USER:$USER" "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"

log_step "Creating instance configs"
admin_token=""
at_rest_key=""
for inst in "${INSTANCES[@]}"; do
    name="${inst%%:*}"
    existing="$CONFIG_DIR/luna-connect-${name}.yaml"
    if [ -f "$existing" ]; then
        if [ -z "$admin_token" ]; then
            admin_token=$(sed -n 's/^  admin_token: "\(.*\)"/\1/p' "$existing" | head -1)
        fi
        if [ -z "$at_rest_key" ]; then
            at_rest_key=$(sed -n 's/^  at_rest_key: "\(.*\)"/\1/p' "$existing" | head -1)
        fi
    fi
done
if [ -z "$admin_token" ]; then
    admin_token=$(openssl rand -hex 32)
fi
if [ -z "$at_rest_key" ]; then
    at_rest_key=$(openssl rand -hex 32)
fi
for inst in "${INSTANCES[@]}"; do
    name="${inst%%:*}"
    port="${inst##*:}"
    config_file="$CONFIG_DIR/luna-connect-${name}.yaml"
    if [ -f "$config_file" ]; then
        log_info "  Config for ${name} already exists"
        continue
    fi
    cat > "$config_file" <<EOF
server:
  address: "127.0.0.1"
  port: ${port}
  base_url: "${BASE_URL}"
  public_zone: "luna.servers.libreloom.org"
  admin_token: "${admin_token}"
  at_rest_key: "${at_rest_key}"
  web_dir: "${INSTALL_DIR}/web"

database:
  path: "${DATA_DIR}/luna-connect.db"
  # Production Postgres (after migrate-sqlite-to-postgres.sh):
  # driver: "postgres"
  # url: "postgres://luna_connect:CHANGE_ME@127.0.0.1:5432/luna_connect?sslmode=disable"

data_dir: "${DATA_DIR}/objects"

cloudflare:
  account_id: ""
  api_token: ""
  zone_id: ""

stripe:
  # Production requires Stripe. Paid routes refuse until secret_key, webhook_secret, and price_id are set.
  # Billing Meters: meter_event_name=luna_backup_gb, aggregation Last, price $0.008/GB linked to the meter.
  enabled: true
  secret_key: ""
  publishable_key: ""
  webhook_secret: ""
  meter_event_name: "luna_backup_gb"
  price_id: ""

backup:
  driver: "local"
  max_object_bytes: 1073741824
  max_account_bytes: 2000000000000
EOF
    chown "$USER:$USER" "$config_file"
    chmod 640 "$config_file"
    log_info "  Wrote $config_file"
done

log_step "Creating systemd services"
template="$SCRIPT_DIR/luna-connect-instance.service.tmpl"
for inst in "${INSTANCES[@]}"; do
    name="${inst%%:*}"
    sed "s/{INSTANCE}/${name}/g" "$template" > "/etc/systemd/system/luna-connect-${name}.service"
    if [ "$name" = "a" ]; then
        mkdir -p "/etc/systemd/system/luna-connect-${name}.service.d"
        cat > "/etc/systemd/system/luna-connect-${name}.service.d/job-leader.conf" <<'EOF'
[Service]
# Only instance A runs background jobs (Stripe meters, retention, orphan cleanup).
# With Postgres, advisory locks also prevent duplicate job runs if both instances start.
Environment=LUNACONNECT_JOB_LEADER=1
EOF
    fi
done
systemctl daemon-reload

log_step "Building Luna Connect"
(cd "$REPO_ROOT/luna-connect/web" && npm install --silent && npm run build)
git_commit=$(cd "$REPO_ROOT" && git rev-parse --short HEAD)
build_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
(cd "$REPO_ROOT/luna-connect" && go build \
    -ldflags "-X main.version=$(git describe --tags --always 2>/dev/null || echo dev) \
              -X main.gitCommit=$git_commit \
              -X main.buildTime=$build_time" \
    -o "$INSTALL_DIR/luna-connect" ./cmd/server)
rm -rf "$INSTALL_DIR/web"
cp -a "$REPO_ROOT/luna-connect/web/dist/." "$INSTALL_DIR/web/"
chown -R "$USER:$USER" "$INSTALL_DIR"

log_step "Starting services"
for inst in "${INSTANCES[@]}"; do
    name="${inst%%:*}"
    port="${inst##*:}"
    svc="luna-connect-${name}"
    systemctl enable "$svc"
    systemctl start "$svc"
    elapsed=0
    while ! curl -sf --max-time 3 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; do
        elapsed=$((elapsed + 1))
        if [ "$elapsed" -ge 30 ]; then
            log_error "${svc} failed to start — journalctl -u ${svc}"
            exit 1
        fi
        sleep 1
    done
    log_info "  ${svc} healthy (port ${port})"
done

echo ""
echo -e "${GREEN}  Luna Connect installed — blue/green ZDU ready${NC}"
echo "  luna-connect-a  →  127.0.0.1:8101"
echo "  luna-connect-b  →  127.0.0.1:8102"
echo "  Shared DB: $DATA_DIR/luna-connect.db"
echo ""
echo "  Next: merge luna-connect/deploy/Caddyfile.conf into /etc/caddy/Caddyfile"
echo "  Then: caddy reload --config /etc/caddy/Caddyfile"
echo ""
echo "  Fill Cloudflare + Stripe in:"
echo "    $CONFIG_DIR/luna-connect-a.yaml"
echo "    $CONFIG_DIR/luna-connect-b.yaml"
echo "  Then: systemctl restart luna-connect-a luna-connect-b"
echo ""
echo "  Deploy updates (zero downtime):"
echo "    cd $REPO_ROOT && git checkout main"
echo "    sudo ./luna-connect/deploy/deploy.sh"
echo "    # tagged release: sudo ./luna-connect/deploy/deploy.sh --tag luna-connect-vX.Y.Z"
echo ""
echo "  Soft drain files (created by deploy.sh, cleared after stop):"
echo "    $DATA_DIR/drain-a   $DATA_DIR/drain-b"
echo ""
