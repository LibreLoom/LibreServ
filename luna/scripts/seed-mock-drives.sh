#!/usr/bin/env bash
# Seed Luna's upgraded mock-drive system and scrub the legacy forced 64GB PSSD.
#
# Unique presets only (skip aliases: docs / code / all).
# Safe to re-run: existing drives are plugged; missing ones are spawned.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${LUNA_DATA_DIR:-${ROOT}/dev}"
export LUNA_DATA_DIR="${DATA_DIR}"

echo ">> Cleaning legacy mock-pssd-vol (if present)"
rm -rf "${DATA_DIR}/mock-pssd-vol"

mkdir -p "${DATA_DIR}/mock-drives"

echo ">> Seeding mock drives under ${DATA_DIR}/mock-drives"
for preset in photos documents media projects deep mixed empty; do
  if [ ! -d "${DATA_DIR}/mock-drives/${preset}" ]; then
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
