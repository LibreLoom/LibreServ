#!/usr/bin/env bash
# Ensure a Luna access token exists for desktop rapid-dev.
# Writes:
#   desktop/.dev/url
#   desktop/.dev/token
#   desktop/.dev/username
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LUNA_ROOT="$(cd "$ROOT/.." && pwd)"
DEV_DIR="$ROOT/.dev"
URL="${LUNA_DESKTOP_URL:-http://127.0.0.1:${LUNA_PORT:-8090}}"
USER="${LUNA_DESKTOP_DEV_USER:-desktop}"
PASS="${LUNA_DESKTOP_DEV_PASS:-hunter22hunter1}"
COOKIE_JAR="$(mktemp)"
HDR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" "$HDR"' EXIT

mkdir -p "$DEV_DIR"

echo "==> Checking Luna at $URL"
if ! curl -fsS -o /dev/null --connect-timeout 2 "$URL/health"; then
  echo "Luna is not reachable at $URL" >&2
  echo "Start it in another terminal:" >&2
  echo "  cd $LUNA_ROOT && make dev-daemon" >&2
  exit 1
fi

# Reuse a still-valid cached token when possible.
if [ -f "$DEV_DIR/token" ] && [ -f "$DEV_DIR/url" ] && [ "$(cat "$DEV_DIR/url")" = "$URL" ]; then
  TOK="$(tr -d '\n' <"$DEV_DIR/token")"
  ME="$(curl -fsS -H "Authorization: Bearer $TOK" "$URL/api/v1/auth/me" || true)"
  if echo "$ME" | grep -q '"username"'; then
    echo "$ME" | python3 -c 'import sys,json; u=json.load(sys.stdin); print(u.get("username",""))' >"$DEV_DIR/username"
    echo "==> Reusing cached access token for $(cat "$DEV_DIR/username")"
    echo "$URL" >"$DEV_DIR/url"
    exit 0
  fi
fi

echo "==> Signing in as $USER to mint an access token"
curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -D "$HDR" \
  -X POST "$URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" >/dev/null \
  || {
    echo "Could not sign in as $USER. Create that user in Luna first, or set" >&2
    echo "LUNA_DESKTOP_DEV_USER / LUNA_DESKTOP_DEV_PASS." >&2
    exit 1
  }

CSRF="$(awk '/luna_csrf/ {print $NF}' "$COOKIE_JAR" | tail -1)"
if [ -z "$CSRF" ]; then
  echo "Luna login did not return a CSRF cookie." >&2
  exit 1
fi

TOK_JSON="$(curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST "$URL/api/v1/device-tokens" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"name":"Luna Desktop (dev)"}')"

TOKEN="$(printf '%s' "$TOK_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')"
printf '%s\n' "$URL" >"$DEV_DIR/url"
printf '%s\n' "$TOKEN" >"$DEV_DIR/token"
printf '%s\n' "$USER" >"$DEV_DIR/username"
chmod 600 "$DEV_DIR/token"

echo "==> Wrote access token to $DEV_DIR/token"
echo "    User: $USER"
echo "    URL:  $URL"
