#!/usr/bin/env bash
# Populate the dev mock 64GB PSSD volume from git-tracked fixtures.
#
# Idempotent: safe to run on every install/boot. Writes into LUNA_DATA_DIR
# (default luna/dev/mock-pssd-vol), which is gitignored runtime data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${LUNA_DATA_DIR:-${ROOT}/dev}"
VOL="${LUNA_MOCK_PSSD_PATH:-${DATA_DIR}/mock-pssd-vol}"
SEED="${ROOT}/fixtures/mock-pssd"

if [ ! -d "${SEED}" ]; then
  echo ">> mock-pssd: seed missing at ${SEED}" >&2
  exit 1
fi

mkdir -p "${VOL}"

# Refresh content when the seed changes (mtime check on README marker).
_stamp="${SEED}/.seed-version"
_vol_stamp="${VOL}/.seed-version"
if [ -f "${_stamp}" ] && [ -f "${_vol_stamp}" ] && cmp -s "${_stamp}" "${_vol_stamp}" 2>/dev/null; then
  echo ">> mock-pssd: volume up to date at ${VOL}"
  exit 0
fi

echo ">> mock-pssd: syncing fixture → ${VOL}"
rm -rf "${VOL:?}"/*
mkdir -p "${VOL}"
cp -a "${SEED}/." "${VOL}/"
cp "${_stamp}" "${_vol_stamp}" 2>/dev/null || true
echo ">> mock-pssd: ready (~64 GB reported, $(du -sh "${VOL}" | awk '{print $1}') on disk)"
