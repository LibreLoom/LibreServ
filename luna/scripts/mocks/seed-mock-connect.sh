#!/usr/bin/env bash
# Idempotent: start Luna Connect mock with cloud backup + a domain name, and
# ensure luna/dev has a paired device credential so lunad treats Connect as active.
#
# Cloud Agents call this from .cursor/start.sh before the luna-backend terminal.
# Local: bash scripts/mocks/seed-mock-connect.sh
#
# Env:
#   LUNA_DATA_DIR           (default: luna/dev)
#   MOCK_CONNECT_HOST       (default: 127.0.0.1)
#   MOCK_CONNECT_PORT       (default: 18765)
#   LUNA_MOCK_SUBDOMAIN     (default: max) → max.luna.servers.libreloom.org
#   LUNA_MOCK_DOMAIN        (optional suffix override)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="${LUNA_DATA_DIR:-${ROOT}/dev}"
export LUNA_DATA_DIR="${DATA_DIR}"
export MOCK_CONNECT_HOST="${MOCK_CONNECT_HOST:-127.0.0.1}"
export MOCK_CONNECT_PORT="${MOCK_CONNECT_PORT:-18765}"
export LUNA_MOCK_STORAGE_DIR="${LUNA_MOCK_STORAGE_DIR:-${DATA_DIR}/mock-cloud-storage}"

SUBDOMAIN="${LUNA_MOCK_SUBDOMAIN:-max}"
DOMAIN_EXTRA=()
if [ -n "${LUNA_MOCK_DOMAIN:-}" ]; then
  DOMAIN_EXTRA=("${LUNA_MOCK_DOMAIN}")
fi

MOCK_SH="${ROOT}/scripts/mocks/mock-connect.sh"
mkdir -p "${DATA_DIR}"

echo ">> Ensuring Luna Connect mock on http://${MOCK_CONNECT_HOST}:${MOCK_CONNECT_PORT}"

# Start in background when nothing is listening yet.
if ! curl -fsS -o /dev/null --connect-timeout 1 \
  "http://${MOCK_CONNECT_HOST}:${MOCK_CONNECT_PORT}/healthz" 2>/dev/null; then
  bash "${MOCK_SH}" serve --daemon --mode bound
  ready=0
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null --connect-timeout 1 \
      "http://${MOCK_CONNECT_HOST}:${MOCK_CONNECT_PORT}/healthz" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 0.1
  done
  if [ "${ready}" -ne 1 ]; then
    echo ">> mock-connect did not become ready on :${MOCK_CONNECT_PORT}" >&2
    exit 1
  fi
  echo ">> mock-connect started"
else
  echo ">> mock-connect already up"
fi

bash "${MOCK_SH}" mode set bound >/dev/null

DEVICE_TOKEN_FILE="${DATA_DIR}/device-token"
CREDENTIAL_FILE="${DATA_DIR}/connect-credential"
# The mock reports only the last four characters of the token (a hint), so the
# local file is checked against that hint.
server_hint="$(bash "${MOCK_SH}" status --json | python3 -c '
import json, sys
state = json.load(sys.stdin)
print(str(state.get("device_token_hint", "")).upper())
')"
need_device=1
if [ -s "${DEVICE_TOKEN_FILE}" ] && [ -s "${CREDENTIAL_FILE}" ]; then
  chmod 600 "${DEVICE_TOKEN_FILE}" "${CREDENTIAL_FILE}"
  token="$(tr -d ' \n\r\t-' <"${DEVICE_TOKEN_FILE}" | tr '[:lower:]' '[:upper:]' | tr 'ILO' '110')"
  credential="$(tr -d '\r\n' <"${CREDENTIAL_FILE}")"
  credential_status="$(curl -sS --connect-timeout 1 --max-time 3 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${credential}" \
    "http://${MOCK_CONNECT_HOST}:${MOCK_CONNECT_PORT}/api/v1/status" 2>/dev/null || true)"
  if [[ "${token}" =~ ^[0-9A-HJKMNP-TV-Z]{20}$ ]] \
    && [[ "${token: -4}" == "${server_hint}" ]] \
    && [[ "${credential_status}" == "200" ]]; then
    need_device=0
  fi
fi

if [ "${need_device}" -eq 1 ]; then
  echo ">> Minting device token and mock credential into ${DATA_DIR}"
  bash "${MOCK_SH}" mint-device --write >/dev/null
else
  echo ">> Reusing paired mock device in ${DATA_DIR}"
fi
chmod 600 "${DEVICE_TOKEN_FILE}" "${CREDENTIAL_FILE}"

# Minting a fresh identity clears the mock's address, so assign it afterward.
bash "${MOCK_SH}" domain set "${SUBDOMAIN}" "${DOMAIN_EXTRA[@]}" >/dev/null
bash "${MOCK_SH}" backup unlock >/dev/null

echo ">> Mock Connect ready:"
bash "${MOCK_SH}" status
echo ">> Point lunad at the mock with:"
echo "     LUNA_CONNECT_URL=http://${MOCK_CONNECT_HOST}:${MOCK_CONNECT_PORT} make -C ${ROOT} dev-daemon"
