#!/usr/bin/env bash
# Desktop wrapper around the shared companion token helper.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LUNA_ROOT="$(cd "$ROOT/.." && pwd)"
export LUNA_DEV_TOKEN_DIR="${LUNA_DEV_TOKEN_DIR:-$ROOT/.dev}"
export LUNA_DEV_TOKEN_NAME="${LUNA_DEV_TOKEN_NAME:-Luna for Linux (dev)}"
export LUNA_URL="${LUNA_URL:-${LUNA_DESKTOP_URL:-http://127.0.0.1:${LUNA_PORT:-8090}}}"
exec bash "$LUNA_ROOT/scripts/ensure-dev-token.sh"
