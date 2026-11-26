#!/usr/bin/env bash
# E2E: provision a fresh Luna device token, pair it with a verified Connect account,
# poll status, assign a domain, and create the first local Admin off-LAN with the
# device token (the /setup#token=<token> path).
#
# This intentionally requires a verified account with no Luna already attached;
# it never bypasses email verification.
#
# Required environment:
#   LUNACONNECT_E2E_EMAIL        verified Connect account email
#   LUNACONNECT_E2E_PASSWORD     that account's password
#
# Optional environment:
#   LUNACONNECT_E2E_URL          Connect base URL (default: http://127.0.0.1:8092)
#   LUNA_E2E_URL                 lunad base URL (default: http://127.0.0.1:8090)
#   LUNA_DATA_DIR                fresh lunad data directory (default: luna/dev)
#   LUNACONNECT_E2E_ADMIN_EMAIL  staff email used to mint a device token
#   LUNACONNECT_E2E_ADMIN_PASSWORD
#   LUNACONNECT_E2E_ADMIN_TOTP_CODE
#   LUNACONNECT_E2E_DEVICE_TOKEN pre-minted 20-character Crockford device token
#                                (grouping and case do not matter)
#   LUNACONNECT_E2E_SUBDOMAIN    name to assign (default: e2e<unix time>)
#   LUNACONNECT_E2E_POLL_ATTEMPTS / LUNACONNECT_E2E_POLL_INTERVAL
#   LUNA_E2E_ADMIN_USERNAME / LUNA_E2E_ADMIN_PASSWORD
#
# Run against a fresh lunad started with this LUNA_DATA_DIR and LUNA_CONNECT_URL
# pointing at Connect. The script replaces local Connect state in LUNA_DATA_DIR.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONNECT_URL="${LUNACONNECT_E2E_URL:-http://127.0.0.1:8092}"
CONNECT_URL="${CONNECT_URL%/}"
LUNA_URL="${LUNA_E2E_URL:-http://127.0.0.1:8090}"
LUNA_URL="${LUNA_URL%/}"
LUNA_DATA="${LUNA_DATA_DIR:-$ROOT/dev}"
ACCOUNT_EMAIL="${LUNACONNECT_E2E_EMAIL:-}"
ACCOUNT_PASSWORD="${LUNACONNECT_E2E_PASSWORD:-}"
ADMIN_EMAIL="${LUNACONNECT_E2E_ADMIN_EMAIL:-e2e-admin@test.luna}"
ADMIN_PASSWORD="${LUNACONNECT_E2E_ADMIN_PASSWORD:-e2e-admin-password1}"
ADMIN_TOTP_CODE="${LUNACONNECT_E2E_ADMIN_TOTP_CODE:-}"
SUBDOMAIN="${LUNACONNECT_E2E_SUBDOMAIN:-e2e$(date +%s)}"
POLL_ATTEMPTS="${LUNACONNECT_E2E_POLL_ATTEMPTS:-60}"
POLL_INTERVAL="${LUNACONNECT_E2E_POLL_INTERVAL:-1}"
LUNA_ADMIN_USERNAME="${LUNA_E2E_ADMIN_USERNAME:-e2e-admin}"
LUNA_ADMIN_PASSWORD="${LUNA_E2E_ADMIN_PASSWORD:-e2e-local-password1}"

log() { echo "[e2e] $*"; }
fail() { echo "[e2e] FAIL: $*" >&2; exit 1; }

for dependency in curl python3; do
  command -v "$dependency" >/dev/null 2>&1 || fail "missing dependency: $dependency"
done
[[ -n "$ACCOUNT_EMAIL" && -n "$ACCOUNT_PASSWORD" ]] \
  || fail "set LUNACONNECT_E2E_EMAIL and LUNACONNECT_E2E_PASSWORD to a verified account"
[[ "$POLL_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || fail "LUNACONNECT_E2E_POLL_ATTEMPTS must be a positive integer"
[[ "$POLL_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "LUNACONNECT_E2E_POLL_INTERVAL must be a non-negative number"
[[ "$SUBDOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "invalid LUNACONNECT_E2E_SUBDOMAIN"
[[ "$LUNA_DATA" != "/" && "$LUNA_DATA" != "$ROOT" ]] || fail "LUNA_DATA_DIR must be a dedicated lunad data directory"
mkdir -p "$LUNA_DATA"
LUNA_DATA="$(cd "$LUNA_DATA" && pwd)"
[[ "$LUNA_DATA" != "/" && "$LUNA_DATA" != "$ROOT" ]] || fail "LUNA_DATA_DIR must resolve to a dedicated lunad data directory"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/luna-connect-e2e.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
ADMIN_JAR="$TMP_DIR/admin.cookies"
ACCOUNT_JAR="$TMP_DIR/account.cookies"
RESPONSE_FILE="$TMP_DIR/response.json"
HTTP_STATUS=""
RESPONSE=""

# Build JSON from alternating key/value arguments without interpolating secrets
# into a shell-quoted JSON literal.
json_body() {
  python3 - "$@" <<'PY'
import json
import sys

print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2])), separators=(",", ":")))
PY
}

json_field() {
  python3 -c '
import json
import sys

try:
    value = json.load(sys.stdin)
    for part in sys.argv[1].split("."):
        value = value[part]
except (KeyError, TypeError, ValueError, json.JSONDecodeError):
    sys.exit(1)

if value is None:
    print("")
elif isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, (dict, list)):
    print(json.dumps(value, separators=(",", ":")))
else:
    print(value)
' "$1"
}

safe_response() {
  python3 -c '
import json
import sys

secret_keys = {"auth_token", "device_token", "password", "token"}

def redact(value):
    if isinstance(value, dict):
        return {key: "<redacted>" if key in secret_keys else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value

try:
    print(json.dumps(redact(json.load(sys.stdin)), sort_keys=True))
except (ValueError, json.JSONDecodeError):
    print("<non-JSON response>")
'
}

http_ok() { [[ "$HTTP_STATUS" =~ ^2[0-9][0-9]$ ]]; }

request() {
  local method="$1" url="$2"
  shift 2
  HTTP_STATUS="$(curl -sS --connect-timeout 5 --max-time 60 \
    -o "$RESPONSE_FILE" -w '%{http_code}' -X "$method" "$url" "$@")" || return 1
  RESPONSE="$(cat "$RESPONSE_FILE")"
}

fail_http() {
  local label="$1" detail
  detail="$(printf '%s' "$RESPONSE" | safe_response)"
  fail "$label (HTTP $HTTP_STATUS): $detail"
}

csrf_token() {
  local jar="$1"
  curl -fsS --connect-timeout 5 --max-time 20 \
    -c "$jar" -b "$jar" "$CONNECT_URL/api/v1/config" >/dev/null || return 1
  awk '$6 == "luna_connect_csrf" { print $7 }' "$jar" | tail -1
}

cookie_get() {
  local jar="$1" path="$2"
  request GET "$CONNECT_URL$path" -b "$jar" -c "$jar"
}

cookie_post() {
  local jar="$1" path="$2" body="$3" token
  token="$(csrf_token "$jar")" || return 1
  [[ -n "$token" ]] || return 1
  request POST "$CONNECT_URL$path" -b "$jar" -c "$jar" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $token" -d "$body"
}

device_request() {
  local method="$1" path="$2" token="$3" body="${4:-}"
  local args=(-H "Authorization: Bearer $token")
  if [[ $# -ge 4 ]]; then
    args+=(-H 'Content-Type: application/json' -d "$body")
  fi
  request "$method" "$CONNECT_URL$path" "${args[@]}"
}

wait_for_url() {
  local label="$1" url="$2" attempt
  for ((attempt = 1; attempt <= POLL_ATTEMPTS; attempt++)); do
    if curl -fsS --connect-timeout 2 --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  fail "$label is not reachable at $url"
}

admin_login() {
  local body login
  csrf_token "$ADMIN_JAR" >/dev/null || fail "could not initialize the staff session"
  # A fresh dev instance can seed its first staff account. An existing instance
  # refuses this call; the normal sign-in below still works.
  cookie_post "$ADMIN_JAR" /admin/seed \
    "$(json_body email "$ADMIN_EMAIL" password "$ADMIN_PASSWORD" name 'E2E Admin')" >/dev/null 2>&1 || true

  if [[ -n "$ADMIN_TOTP_CODE" ]]; then
    body="$(json_body email "$ADMIN_EMAIL" password "$ADMIN_PASSWORD" totp_code "$ADMIN_TOTP_CODE")"
  else
    body="$(json_body email "$ADMIN_EMAIL" password "$ADMIN_PASSWORD")"
  fi
  cookie_post "$ADMIN_JAR" /admin/login "$body" || fail "staff sign-in request failed"
  http_ok || fail_http "staff sign-in"
  login="$(json_field requires_2fa || true)"
  [[ "$login" != "true" ]] || fail "staff sign-in requires LUNACONNECT_E2E_ADMIN_TOTP_CODE"
}

mint_identity() {
  local raw_token="${LUNACONNECT_E2E_DEVICE_TOKEN:-}"
  if [[ -z "$raw_token" ]]; then
    log "Signing in as staff to mint a fresh device token"
    admin_login
    cookie_post "$ADMIN_JAR" /admin/device-codes '{}' || fail "device token mint request failed"
    http_ok || fail_http "device token mint"
    raw_token="$(json_field device_token)" || fail_http "device token mint response has no device_token"
  fi

  DEVICE_TOKEN="$(printf '%s' "$raw_token" | tr -d '[:space:]-' | tr '[:lower:]' '[:upper:]')"
  [[ "$DEVICE_TOKEN" =~ ^[0-9A-HJKMNP-TV-Z]{20}$ ]] || fail "device token is not a 20-character Crockford value"
  DEVICE_TOKEN_GROUPED="$(python3 -c 'import sys; value=sys.argv[1]; print("-".join(value[i:i+4] for i in range(0, len(value), 4)))' "$DEVICE_TOKEN")"
  log "Device token ready (not printed)"
}

account_login() {
  local body verified devices
  body="$(json_body email "$ACCOUNT_EMAIL" password "$ACCOUNT_PASSWORD")"
  cookie_post "$ACCOUNT_JAR" /api/v1/account/login "$body" || fail "account sign-in request failed"
  http_ok || fail_http "account sign-in"

  cookie_get "$ACCOUNT_JAR" /api/v1/account/verification-status || fail "verification-status request failed"
  http_ok || fail_http "verification-status"
  verified="$(json_field email_verified || true)"
  [[ "$verified" == "true" ]] || fail "the E2E Connect account must have a verified email"

  cookie_get "$ACCOUNT_JAR" /api/v1/account/devices || fail "account devices request failed"
  http_ok || fail_http "account devices"
  devices="$(json_field devices || true)"
  [[ "$devices" == "[]" ]] || fail "the E2E Connect account already has a Luna attached"
  log "Signed in to the verified Connect account"
}

prepare_lunad() {
  local status has_admin
  request GET "$LUNA_URL/api/v1/auth/status" || fail "lunad auth status request failed"
  http_ok || fail_http "lunad auth status"
  has_admin="$(json_field has_admin || true)"
  [[ "$has_admin" == "false" ]] || fail "LUNA_DATA_DIR must belong to a fresh Luna with no local users"

  log "Writing device-token to $LUNA_DATA"
  # Earlier pairing files are gone: the device token is the only pairing secret.
  rm -f "$LUNA_DATA/device-uid" "$LUNA_DATA/pairing-code" "$LUNA_DATA/setup-token"
  rm -f "$LUNA_DATA/connect-credential" "$LUNA_DATA/connect-unbind-pending" "$LUNA_DATA/connect.json"
  (umask 077; printf '%s\n' "$DEVICE_TOKEN" >"$LUNA_DATA/device-token")
  chmod 600 "$LUNA_DATA/device-token"
  status="$(cat "$LUNA_DATA/device-token")"
  [[ "$status" == "$DEVICE_TOKEN" ]] || fail "could not write device-token"
}

start_pairing() {
  local body
  body="$(json_body device_token "$DEVICE_TOKEN_GROUPED")"
  cookie_post "$ACCOUNT_JAR" /api/v1/devices/pair "$body" || fail "pairing request failed"
  http_ok || fail_http "start pairing"
  PAIRING_ID="$(json_field pairing_id)" || fail_http "pairing response has no pairing_id"
  [[ -n "$PAIRING_ID" ]] || fail "pairing response has an empty pairing_id"
  log "Pairing attempt started"
}

wait_for_pairing() {
  local attempt state device_id
  AUTH_TOKEN=""
  PAIR_DEVICE_ID=""
  for ((attempt = 1; attempt <= POLL_ATTEMPTS; attempt++)); do
    if [[ -s "$LUNA_DATA/connect-credential" ]]; then
      AUTH_TOKEN="$(tr -d '\r\n' <"$LUNA_DATA/connect-credential")"
    fi

    cookie_get "$ACCOUNT_JAR" "/api/v1/devices/pair/$PAIRING_ID" || true
    if http_ok; then
      state="$(json_field status || true)"
      if [[ "$state" == "bound" ]]; then
        device_id="$(json_field device_id)" || fail_http "bound pairing response has no device_id"
        [[ -n "$device_id" ]] || fail "bound pairing response has an empty device_id"
        PAIR_DEVICE_ID="$device_id"
      fi
    fi

    if [[ -n "$PAIR_DEVICE_ID" && -n "$AUTH_TOKEN" ]]; then
      [[ "$AUTH_TOKEN" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "lunad stored an invalid rolling credential"
      log "Luna claimed the pairing attempt"
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  fail "lunad did not claim the pairing attempt; check that it uses $LUNA_DATA and $CONNECT_URL"
}

check_connect_status() {
  local bound device_id
  device_request GET /api/v1/status "$AUTH_TOKEN" || fail "Connect status request failed"
  http_ok || fail_http "Connect status"
  bound="$(json_field bound || true)"
  device_id="$(json_field device_id || true)"
  [[ "$bound" == "true" ]] || fail "Connect status does not report a bound device"
  [[ "$device_id" == "$PAIR_DEVICE_ID" ]] || fail "Connect status returned a different device_id"
  DEVICE_ID="$device_id"
  log "Connect status confirms the bound device"
}

assign_domain() {
  local body hostname
  body="$(json_body subdomain "$SUBDOMAIN")"
  cookie_post "$ACCOUNT_JAR" "/api/v1/devices/$DEVICE_ID/domain" "$body" || fail "domain request failed"
  http_ok || fail_http "domain assignment"
  hostname="$(json_field hostname)" || fail_http "domain response has no hostname"
  [[ -n "$hostname" ]] || fail "domain response has an empty hostname"
  DEVICE_HOSTNAME="$hostname"
  log "Domain assigned: $DEVICE_HOSTNAME"
}

wait_for_lunad_domain() {
  local attempt subdomain hostname
  for ((attempt = 1; attempt <= POLL_ATTEMPTS; attempt++)); do
    request GET "$LUNA_URL/api/v1/connect/status" || true
    if http_ok; then
      subdomain="$(json_field subdomain || true)"
      hostname="$(json_field hostname || true)"
      if [[ "$subdomain" == "$SUBDOMAIN" || "$hostname" == "$DEVICE_HOSTNAME" ]]; then
        return 0
      fi
    fi
    sleep "$POLL_INTERVAL"
  done
  fail "lunad did not receive the assigned domain"
}

# Once bound, Connect ignores the device token: a claim with it must get the same
# generic 404 as an unknown token and must not start a new pairing.
check_token_ignored_when_bound() {
  local body
  body="$(json_body device_token "$DEVICE_TOKEN")"
  request POST "$CONNECT_URL/api/v1/devices/pair/claim" -H 'Content-Type: application/json' -d "$body" || fail "bound claim request failed"
  [[ "$HTTP_STATUS" == "404" ]] || fail_http "a bound device accepted its device token again"
  log "Connect ignores the device token while the device is bound"
}

# Off-LAN first-Admin registration. $1 is the device token to send, or empty for
# none. Sets HTTP_STATUS and RESPONSE; never fails the script by itself.
register_off_lan() {
  local token="${1:-}" body
  HTTP_STATUS="000"
  if [[ -n "$token" ]]; then
    body="$(json_body username "$LUNA_ADMIN_USERNAME" display_name 'E2E Admin' \
      password "$LUNA_ADMIN_PASSWORD" device_token "$token")"
  else
    body="$(json_body username "$LUNA_ADMIN_USERNAME" display_name 'E2E Admin' \
      password "$LUNA_ADMIN_PASSWORD")"
  fi
  request POST "$LUNA_URL/api/v1/auth/register" \
    -H 'Content-Type: application/json' \
    -H "Host: $DEVICE_HOSTNAME" \
    -H "X-Forwarded-For: 203.0.113.10" \
    -H 'X-Forwarded-Proto: https' \
    -H "Origin: https://$DEVICE_HOSTNAME" \
    -H 'Sec-Fetch-Site: same-origin' \
    -d "$body" || true
}

assert_no_local_admin() {
  request GET "$LUNA_URL/api/v1/auth/status" || fail "lunad auth status request failed"
  http_ok || fail_http "lunad auth status"
  [[ "$(json_field has_admin || true)" == "false" ]] || fail "a refused off-LAN registration created an Admin"
}

create_first_admin_off_lan() {
  local setup_url wrong_token current_token role has_admin
  # The setup page reads the token from the URL fragment (never the query string).
  setup_url="https://$DEVICE_HOSTNAME/setup#token=$DEVICE_TOKEN"
  python3 - "$setup_url" "$DEVICE_TOKEN" "$DEVICE_HOSTNAME" <<'PY' || fail "setup URL must carry only the device token fragment"
import sys
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
token = sys.argv[2]
hostname = sys.argv[3]
if url.scheme != "https" or url.netloc != hostname or url.path != "/setup" or url.query:
    sys.exit(1)
if url.fragment != "token=" + token:
    sys.exit(1)
PY
  log "Setup link carries the device token in its fragment only"

  # Refused: no token, a wrong token, and the rolling credential. Luna never falls
  # back to the auth token and never fails open.
  register_off_lan ""
  http_ok && fail "off-LAN registration without a device token was accepted"
  assert_no_local_admin
  log "Off-LAN registration without a device token is refused"

  wrong_token="${DEVICE_TOKEN:0:19}$([[ "${DEVICE_TOKEN: -1}" == "A" ]] && echo B || echo A)"
  register_off_lan "$wrong_token"
  http_ok && fail "off-LAN registration with a wrong device token was accepted"
  assert_no_local_admin
  log "Off-LAN registration with a wrong device token is refused"

  [[ -s "$LUNA_DATA/connect-credential" ]] || fail "lunad removed its rolling credential during setup"
  current_token="$(tr -d '\r\n' <"$LUNA_DATA/connect-credential")"
  register_off_lan "$current_token"
  http_ok && fail "off-LAN registration accepted the rolling credential as a device token"
  assert_no_local_admin
  log "Off-LAN registration with the rolling credential is refused"

  # Accepted: the grouped form works, because Luna ignores grouping and case.
  register_off_lan "$DEVICE_TOKEN_GROUPED"
  http_ok || fail_http "remote first-Admin registration with the device token"
  role="$(json_field role || true)"
  [[ "$role" == "admin" ]] || fail "the first local account was not created as Admin"

  request GET "$LUNA_URL/api/v1/auth/status" || fail "lunad auth status request failed"
  http_ok || fail_http "lunad auth status"
  has_admin="$(json_field has_admin || true)"
  [[ "$has_admin" == "true" ]] || fail "lunad does not report a local Admin"
  log "Off-LAN first-Admin setup succeeded with the device token"
}

log "Checking Connect at $CONNECT_URL and Luna at $LUNA_URL"
wait_for_url "luna-connect" "$CONNECT_URL/healthz"
wait_for_url "lunad" "$LUNA_URL/health"

mint_identity
account_login
prepare_lunad
start_pairing
wait_for_pairing
check_connect_status
assign_domain
wait_for_lunad_domain
check_token_ignored_when_bound
create_first_admin_off_lan

log "Full E2E setup flow passed"
log "  pair -> Luna claim -> rolling credential -> status -> domain -> off-LAN first Admin"
log "  device_id=$DEVICE_ID hostname=$DEVICE_HOSTNAME"
