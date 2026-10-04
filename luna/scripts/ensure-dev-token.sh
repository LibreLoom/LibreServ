#!/usr/bin/env bash
# Mint (or reuse) a Luna access token for companion rapid-dev.
# Writes into $LUNA_DEV_TOKEN_DIR:
#   url, token, username
#
# Env:
#   LUNA_DEV_TOKEN_DIR   required output directory (e.g. desktop/.dev)
#   LUNA_URL / LUNA_DESKTOP_URL / LUNA_PORT
#   LUNA_DEV_USER / LUNA_DESKTOP_DEV_USER   (default: desktop)
#   LUNA_DEV_PASS / LUNA_DESKTOP_DEV_PASS   (default: a random password
#                        generated once per workspace, kept 0600 in
#                        $LUNA_DEV_PASS_FILE or luna/dev/dev-password)
#   LUNA_DEV_TOKEN_NAME                    label stored on the token
set -euo pipefail

LUNA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DIR="${LUNA_DEV_TOKEN_DIR:?set LUNA_DEV_TOKEN_DIR to the .dev output directory}"
URL="${LUNA_URL:-${LUNA_DESKTOP_URL:-http://127.0.0.1:${LUNA_PORT:-8090}}}"
USER="${LUNA_DEV_USER:-${LUNA_DESKTOP_DEV_USER:-desktop}}"
TOKEN_NAME="${LUNA_DEV_TOKEN_NAME:-Luna companion (dev)}"
COOKIE_JAR="$(mktemp)"
HDR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" "$HDR"' EXIT

mkdir -p "$DEV_DIR"

# An explicit env password wins; otherwise generate one once per workspace
# and keep it in luna/dev/dev-password (0600, gitignored — the dev data dir).
# It's shared across companions so desktop and mobile sign in to the same
# dev account; the account is stable across runs without a committed
# default credential.
PASS="${LUNA_DEV_PASS:-${LUNA_DESKTOP_DEV_PASS:-}}"
if [ -z "$PASS" ]; then
  PASS_FILE="${LUNA_DEV_PASS_FILE:-$LUNA_ROOT/dev/dev-password}"
  if [ -f "$PASS_FILE" ]; then
    PASS="$(tr -d '\n' <"$PASS_FILE")"
  else
    mkdir -p "$(dirname "$PASS_FILE")"
    PASS="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    (umask 077; printf '%s\n' "$PASS" >"$PASS_FILE")
  fi
fi

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

try_login() {
  curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -D "$HDR" \
    -X POST "$URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" >/dev/null
}

echo "==> Signing in as $USER to mint an access token"
if ! try_login; then
  # A fresh dev daemon has no users yet — on LAN/loopback the first
  # registration is open, so create the account and retry once.
  if curl -fsS -o /dev/null \
    -X POST "$URL/api/v1/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$USER\",\"display_name\":\"$USER\",\"password\":\"$PASS\"}" 2>/dev/null \
    && try_login; then
    :
  else
    echo "Could not sign in as $USER." >&2
    echo "If that Luna already has accounts, set LUNA_DEV_PASS (or" >&2
    echo "LUNA_DESKTOP_DEV_PASS) to the account's password. This workspace's" >&2
    echo "generated dev password is in ${LUNA_DEV_PASS_FILE:-$LUNA_ROOT/dev/dev-password}." >&2
    exit 1
  fi
fi

CSRF="$(awk '/luna_csrf/ {print $NF}' "$COOKIE_JAR" | tail -1)"
if [ -z "$CSRF" ]; then
  echo "Luna login did not return a CSRF cookie." >&2
  exit 1
fi

TOK_JSON="$(curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST "$URL/api/v1/device-tokens" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $CSRF" \
  -d "{\"name\":\"$TOKEN_NAME\"}")"

TOKEN="$(printf '%s' "$TOK_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')"
printf '%s\n' "$URL" >"$DEV_DIR/url"
printf '%s\n' "$TOKEN" >"$DEV_DIR/token"
printf '%s\n' "$USER" >"$DEV_DIR/username"
chmod 600 "$DEV_DIR/token"

echo "==> Wrote access token to $DEV_DIR/token"
echo "    User: $USER"
echo "    URL:  $URL"
