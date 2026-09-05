#!/usr/bin/env bash
# Mobile wrapper around the shared companion token helper.
# Token is minted against the host-reachable Luna URL (not the emulator alias).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LUNA_ROOT="$(cd "$ROOT/.." && pwd)"
export LUNA_DEV_TOKEN_DIR="${LUNA_DEV_TOKEN_DIR:-$ROOT/.dev}"
export LUNA_DEV_TOKEN_NAME="${LUNA_DEV_TOKEN_NAME:-Luna Android (dev)}"
export LUNA_URL="${LUNA_URL:-${LUNA_MOBILE_HOST_URL:-${LUNA_DESKTOP_URL:-http://127.0.0.1:${LUNA_PORT:-8090}}}}"
exec bash "$LUNA_ROOT/scripts/ensure-dev-token.sh"
