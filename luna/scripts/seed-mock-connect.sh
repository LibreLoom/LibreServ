#!/usr/bin/env bash
# Idempotent: start Luna Connect mock with cloud backup + a domain name, and
# ensure luna/dev has a valid device-token so lunad treats Connect as active.
#
# Cloud Agents call this from .cursor/start.sh before the luna-backend terminal.
# Local: bash scripts/seed-mock-connect.sh
#
# Env:
#   LUNA_DATA_DIR           (default: luna/dev)
#   MOCK_CONNECT_HOST       (default: 127.0.0.1)
#   MOCK_CONNECT_PORT       (default: 18765)
#   LUNA_MOCK_SUBDOMAIN     (default: max) → max.luna.servers.libreloom.org
#   LUNA_MOCK_DOMAIN        (optional suffix override)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

MOCK_SH="${ROOT}/scripts/mock-connect.sh"
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
bash "${MOCK_SH}" domain set "${SUBDOMAIN}" "${DOMAIN_EXTRA[@]}" >/dev/null
bash "${MOCK_SH}" backup unlock >/dev/null

TOKEN_FILE="${DATA_DIR}/device-token"
need_token=1
if [ -f "${TOKEN_FILE}" ]; then
  raw="$(tr -d ' \n\r\t-' <"${TOKEN_FILE}" | tr '[:lower:]' '[:upper:]' | tr 'ILO' '110')"
  # Crockford length 16..32; alphabet without I L O U.
  if [[ "${raw}" =~ ^[0-9A-HJKMNP-TV-Z]{16,32}$ ]]; then
    need_token=0
  fi
fi

if [ "${need_token}" -eq 1 ]; then
  echo ">> Minting device-token into ${TOKEN_FILE}"
  bash "${MOCK_SH}" mint-token --write >/dev/null
else
  echo ">> Reusing existing device-token at ${TOKEN_FILE}"
fi

echo ">> Mock Connect ready:"
bash "${MOCK_SH}" status
echo ">> Point lunad at the mock with:"
echo "     LUNA_CONNECT_URL=http://${MOCK_CONNECT_HOST}:${MOCK_CONNECT_PORT} make -C ${ROOT} dev-daemon"
