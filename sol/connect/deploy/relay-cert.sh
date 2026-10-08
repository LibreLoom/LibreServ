#!/bin/bash
set -euo pipefail

# Sol Connect — certificate for the SMTP relay (smtp.serv.libreloom.org).
#
# The relay host is a DNS-only (grey-cloud) record pointing at this server,
# so Let's Encrypt can validate it over HTTP. Caddy listens on loopback only
# (the Cloudflare tunnel reaches it there), which leaves the public address
# free: certbot binds port 80 on the public IP just long enough to answer
# the challenge, at issue and at each renewal.
#
# A deploy hook copies the certificate where the Connect service user can
# read it. The relay re-reads the files when they change, so renewals need
# no restart.
#
# Usage (as root, once per server):
#   ./sol/connect/deploy/relay-cert.sh [public-ip]
# Then set in each instance config (connect-a.yaml, connect-b.yaml):
#   smtp:
#     relay_tls_cert: /etc/sol-connect/tls/relay.crt
#     relay_tls_key:  /etc/sol-connect/tls/relay.key

DOMAIN="${RELAY_DOMAIN:-smtp.serv.libreloom.org}"
SERVICE_USER="sol-connect"
TLS_DIR="/etc/sol-connect/tls"
HOOK="/etc/letsencrypt/renewal-hooks/deploy/sol-connect-relay.sh"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root." >&2
    exit 1
fi

PUBLIC_IP="${1:-$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')}"
if [ -z "$PUBLIC_IP" ]; then
    echo "Could not find the public IP for $DOMAIN. Pass it as the first argument." >&2
    exit 1
fi
if ! ip -o addr show | grep -qw "$PUBLIC_IP"; then
    echo "$PUBLIC_IP is not an address on this server; $DOMAIN must point here (DNS-only)." >&2
    exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq certbot
fi

install -d -m 0750 -o root -g "$SERVICE_USER" "$TLS_DIR"
install -d -m 0755 "$(dirname "$HOOK")"
cat > "$HOOK" <<HOOKEOF
#!/bin/sh
# Copy the renewed relay certificate where Sol Connect can read it.
set -e
[ "\${RENEWED_LINEAGE:-}" = "/etc/letsencrypt/live/$DOMAIN" ] || exit 0
install -m 0640 -o root -g $SERVICE_USER "\$RENEWED_LINEAGE/fullchain.pem" "$TLS_DIR/relay.crt.new"
install -m 0640 -o root -g $SERVICE_USER "\$RENEWED_LINEAGE/privkey.pem" "$TLS_DIR/relay.key.new"
mv -f "$TLS_DIR/relay.key.new" "$TLS_DIR/relay.key"
mv -f "$TLS_DIR/relay.crt.new" "$TLS_DIR/relay.crt"
HOOKEOF
chmod 0755 "$HOOK"

certbot certonly --standalone --non-interactive --agree-tos \
    --register-unsafely-without-email \
    --http-01-address "$PUBLIC_IP" --http-01-port 80 \
    -d "$DOMAIN" \
    --deploy-hook "$HOOK"

# certonly runs the deploy hook only for new or renewed certificates; run it
# once more so a re-run with an existing certificate still copies the files.
RENEWED_LINEAGE="/etc/letsencrypt/live/$DOMAIN" "$HOOK"

echo "Relay certificate installed in $TLS_DIR (renewals: certbot.timer)."
