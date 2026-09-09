#!/bin/bash
# LibreServ installer entrypoint.
# Sources install-lib/install-parts/*.sh from a full checkout (sibling of install.sh).
# One-file curl installs need a release that vendors these parts or inlines verified restic download.
set -euo pipefail

_INSTALL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
_PARTS="${_INSTALL_ROOT}/install-lib/install-parts"
if [ ! -d "${_PARTS}" ]; then
  echo "[ERROR] Missing ${_PARTS}. Run from a full LibreServ checkout." >&2
  exit 1
fi
for _part in "${_PARTS}"/0*.sh; do
  # shellcheck disable=SC1090
  source "${_part}"
done
