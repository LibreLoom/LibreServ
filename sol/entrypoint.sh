#!/bin/sh
set -e

CADDY_DIR="/etc/caddy"
CADDYFILE="${CADDY_DIR}/Caddyfile"

if [ ! -f "$CADDYFILE" ]; then
    echo ">> Bootstrapping minimal Caddyfile (none found in ${CADDY_DIR})"
    mkdir -p "$CADDY_DIR" 2>/dev/null || {
        echo ">> Cannot create ${CADDY_DIR} (running as non-root), skipping Caddyfile bootstrap"
        exec /app/sol "$@"
    }
    cat > "$CADDYFILE" <<'CADDYEOF'
# Sol bootstrap Caddyfile
# Auto-generated on first start — replaced by Sol after initialization

:80 {
	respond 502
}
CADDYEOF
fi

exec /app/sol "$@"
