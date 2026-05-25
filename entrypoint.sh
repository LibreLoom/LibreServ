#!/bin/sh
set -e

CADDY_DIR="/etc/caddy"
CADDYFILE="${CADDY_DIR}/Caddyfile"

if [ ! -f "$CADDYFILE" ]; then
    echo ">> Bootstrapping minimal Caddyfile (none found in ${CADDY_DIR})"
    mkdir -p "$CADDY_DIR"
    cat > "$CADDYFILE" <<'CADDYEOF'
# LibreServ bootstrap Caddyfile
# Auto-generated on first start — replaced by LibreServ after initialization

:80 {
	respond 502
}
CADDYEOF
fi

exec /app/libreserv "$@"
