#!/usr/bin/env bash
# Seed Luna's upgraded mock-drive system and scrub the legacy forced 64GB PSSD.
#
# Unique presets only (skip aliases: docs / code / all).
# Safe to re-run: existing drives are plugged; missing ones are spawned.
# Photos/mixed are refreshed when fixtures/mock-pssd/.seed-version changes
# (or when a drive still has the old synthetic stub photos).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${LUNA_DATA_DIR:-${ROOT}/dev}"
export LUNA_DATA_DIR="${DATA_DIR}"
PHOTO_SEED="${ROOT}/fixtures/mock-pssd/.seed-version"

echo ">> Cleaning legacy mock-pssd-vol (if present)"
rm -rf "${DATA_DIR}/mock-pssd-vol"

mkdir -p "${DATA_DIR}/mock-drives"

needs_photo_refresh() {
  local drive="$1"
  local stamp="${drive}/.photo-seed-version"
  if [ ! -d "${drive}" ]; then
    return 0
  fi
  if [ ! -f "${PHOTO_SEED}" ]; then
    return 1
  fi
  if [ ! -f "${stamp}" ]; then
    return 0
  fi
  ! cmp -s "${PHOTO_SEED}" "${stamp}" 2>/dev/null
}

echo ">> Seeding mock drives under ${DATA_DIR}/mock-drives"
for preset in photos documents media projects deep mixed empty; do
  drive="${DATA_DIR}/mock-drives/${preset}"
  if [ "${preset}" = "photos" ] || [ "${preset}" = "mixed" ]; then
    if needs_photo_refresh "${drive}"; then
      echo ">> Refreshing ${preset} drive from photo fixtures"
      (cd "${ROOT}" && make mock-drive ARGS="delete ${preset}") || true
      (cd "${ROOT}" && make mock-drive ARGS="spawn ${preset} ${preset}")
      continue
    fi
  fi
  if [ ! -d "${drive}" ]; then
    (cd "${ROOT}" && make mock-drive ARGS="spawn ${preset} ${preset}")
  else
    (cd "${ROOT}" && make mock-drive ARGS="plug ${preset}") || true
  fi
done

if [ -f "${DATA_DIR}/luna.db" ]; then
  python3 - <<'PY'
import os
import sqlite3
from pathlib import Path

db = Path(os.environ["LUNA_DATA_DIR"]) / "luna.db"
con = sqlite3.connect(db)
cur = con.cursor()
ids = [r[0] for r in cur.execute("SELECT id FROM drives WHERE device = 'sdmock'")]
for did in ids:
    for table, col in (
        ("index_entries", "drive_id"),
        ("indexed_dirs", "drive_id"),
        ("file_hashes", "drive_id"),
        ("uploads", "drive_id"),
        ("grants", "drive_id"),
        ("shares", "drive_id"),
    ):
        cur.execute(f"DELETE FROM {table} WHERE {col} = ?", (did,))
    cur.execute("DELETE FROM jobs WHERE from_drive = ? OR to_drive = ?", (did, did))
    cur.execute(
        "DELETE FROM protections WHERE source_drive = ? OR target_drive = ?",
        (did, did),
    )
    cur.execute("DELETE FROM drives WHERE id = ?", (did,))
con.commit()
con.close()
print(f">> Removed {len(ids)} legacy sdmock drive row(s) from luna.db")
PY
fi

(cd "${ROOT}" && make mock-drive ARGS=list) || true
