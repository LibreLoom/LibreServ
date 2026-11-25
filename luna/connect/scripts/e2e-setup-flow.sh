#!/usr/bin/env bash
# Compatibility entry point; the canonical Luna Connect E2E flow lives in luna/scripts.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/../../scripts/e2e-setup-flow.sh" "$@"
