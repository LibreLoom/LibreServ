#!/usr/bin/env bash
# CLI frontend and server launcher for Luna Connect Mock
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LUNA_DATA_DIR="${LUNA_DATA_DIR:-${ROOT}/dev}"
export MOCK_CONNECT_HOST="${MOCK_CONNECT_HOST:-127.0.0.1}"
export MOCK_CONNECT_PORT="${MOCK_CONNECT_PORT:-18765}"
export LUNA_MOCK_STORAGE_DIR="${LUNA_MOCK_STORAGE_DIR:-${LUNA_DATA_DIR}/mock-cloud-storage}"

exec python3 "${ROOT}/scripts/mock-connect.py" "$@"
