#!/usr/bin/env bash
# CLI frontend for Luna Mock Drives
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LUNA_DATA_DIR="${LUNA_DATA_DIR:-${ROOT}/dev}"

exec python3 "${ROOT}/scripts/mock-drive.py" "$@"
