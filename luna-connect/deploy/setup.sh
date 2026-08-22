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
BASE_URL="${BASE_URL:-https://connect.luna.libreserv.org}"

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
for inst in "${INSTANCES[@]}"; do
    name="${inst%%:*}"
    port="${inst##*:}"
    config_file="$CONFIG_DIR/luna-connect-${name}.yaml"
    if [ -f "$config_file" ]; then
        log_info "  Config for ${name} already exists"
        continue
    fi
    admin_token=$(openssl rand -hex 32)
    cat > "$config_file" <<EOF
server:
  address: "127.0.0.1"
  port: ${port}
  base_url: "${BASE_URL}"
  public_zone: "luna.servers.libreloom.org"
  admin_token: "${admin_token}"
  web_dir: "${INSTALL_DIR}/web"

database:
  path: "${DATA_DIR}/luna-connect.db"

data_dir: "${DATA_DIR}/objects"

cloudflare:
  account_id: ""
  api_token: ""
  zone_id: ""

stripe:
  enabled: false
  secret_key: ""
  webhook_secret: ""
  price_id: ""

backup:
  driver: "local"
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
echo "    cd $REPO_ROOT && ./luna-connect/deploy/deploy.sh"
echo ""
