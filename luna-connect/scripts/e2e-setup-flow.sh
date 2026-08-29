#!/usr/bin/env bash
# E2E test: full Luna Connect setup flow with live luna-connect + lunad phone-home.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONNECT_URL="${LUNACONNECT_E2E_URL:-http://127.0.0.1:8092}"
LUNA_DATA="${LUNA_DATA_DIR:-/agent/repos/libreserv/luna/dev}"
ADMIN_TOKEN="${LUNACONNECT_ADMIN_TOKEN:-e2e-live-admin}"
SUBDOMAIN="live$(date +%s | tail -c 5)"

log() { echo "[e2e] $*"; }
fail() { echo "[e2e] FAIL: $*" >&2; exit 1; }

csrf_get() {
  curl -s -c /tmp/lc-cookies.txt -b /tmp/lc-cookies.txt "$CONNECT_URL/api/v1/config" >/dev/null
  CSRF=$(grep luna_connect_csrf /tmp/lc-cookies.txt | awk '{print $7}')
}

csrf_post() {
  local path="$1" body="$2"
  csrf_get
  curl -s -b /tmp/lc-cookies.txt -c /tmp/lc-cookies.txt \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF" \
    -X POST "$CONNECT_URL$path" -d "$body"
}

wait_for_connect() {
  for _ in $(seq 1 30); do
    curl -sf "$CONNECT_URL/healthz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  fail "luna-connect not reachable at $CONNECT_URL"
}

wait_for_live_socket() {
  for i in $(seq 1 30); do
    SESSION=$(curl -s -b /tmp/lc-cookies.txt "$CONNECT_URL/api/v1/onboarding/session")
    LIVE=$(echo "$SESSION" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('live') else 'false')" 2>/dev/null || echo "false")
    STATUS=$(echo "$SESSION" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    if [[ "$LIVE" == "true" && ("$STATUS" == "attached" || "$STATUS" == "waiting_device") ]]; then
      log "Live WebSocket detected (status=$STATUS)"
      return 0
    fi
    sleep 1
  done
  fail "lunad never established live WebSocket: $SESSION"
}

wait_for_lunad_claim() {
  for _ in $(seq 1 30); do
    if [[ -f "$LUNA_DATA/connect.json" ]] && grep -q '"device_token"' "$LUNA_DATA/connect.json" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "lunad never received claimed state"
}

# --- Step 0: luna-connect health ---
log "Checking luna-connect at $CONNECT_URL"
wait_for_connect

# --- Step 1: mint official setup token ---
log "Minting official setup token"
MINT=$(curl -s -X POST "$CONNECT_URL/admin/setup-tokens" -H "Authorization: Bearer $ADMIN_TOKEN")
TOKEN=$(echo "$MINT" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null) \
  || fail "mint failed: $MINT"
log "Official setup token minted"

# --- Step 2: prepare lunad (setup-token, clear prior claim) ---
log "Writing setup-token → $LUNA_DATA/setup-token"
echo "$TOKEN" > "$LUNA_DATA/setup-token"
rm -f "$LUNA_DATA/connect.json"

# --- Step 3: website — register + bind (device not online yet) ---
EMAIL="e2e-live-$(date +%s)@test.luna"
log "Registering Luna Connect account"
REG=$(csrf_post "/api/v1/account/register" "{\"email\":\"$EMAIL\",\"password\":\"password1234\"}")
echo "$REG" | grep -q '"email"' || fail "register: $REG"

log "Binding official setup code on website"
BIND=$(csrf_post "/api/v1/onboarding/bind" "{\"code\":\"$TOKEN\"}")
echo "$BIND" | grep -qE 'waiting_device|attached' || fail "bind: $BIND"
BIND_STATUS=$(echo "$BIND" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
log "Bind status: $BIND_STATUS"

if [[ "$BIND_STATUS" == "attached" ]]; then
  log "Luna already phoned home before bind"
else
  log "Waiting for lunad to phone home…"
  wait_for_live_socket
fi

# Ensure socket is live right before naming (lunad hello_once blocks until claimed)
wait_for_live_socket
log "Luna attached via WebSocket hello"

# --- Step 5: pick public name → Cloudflare mock + claimed push ---
log "Picking subdomain: $SUBDOMAIN"
NAME=$(csrf_post "/api/v1/onboarding/name" "{\"subdomain\":\"$SUBDOMAIN\"}")
HOST=$(echo "$NAME" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hostname',''))" 2>/dev/null)
[[ -n "$HOST" ]] || fail "name: $NAME"
log "Hostname assigned: $HOST"

# --- Step 6: lunad receives claimed over WebSocket ---
wait_for_lunad_claim
log "lunad connect.json updated with device_token"

# --- Step 7: verify lunad + cloud state ---
sleep 1
CONNECT_STATUS=$(curl -s http://localhost:8090/api/v1/connect/status)
log "lunad status: $CONNECT_STATUS"
echo "$CONNECT_STATUS" | grep -q '"enabled":true' || fail "lunad not enabled"
echo "$CONNECT_STATUS" | grep -q "$SUBDOMAIN" || fail "subdomain missing from lunad status"

DEV_TOKEN=$(python3 -c "import json; print(json.load(open('$LUNA_DATA/connect.json'))['device_token'])")
STATUS=$(curl -s -H "Authorization: Bearer $DEV_TOKEN" "$CONNECT_URL/api/v1/status")
log "Connect device status: $STATUS"
echo "$STATUS" | grep -q '"paired":true' || fail "not paired: $STATUS"

log "✓ Full E2E setup flow passed"
log "  mint → bind → lunad phone-home → name → Cloudflare mock → claimed"
log "  hostname=$HOST"
