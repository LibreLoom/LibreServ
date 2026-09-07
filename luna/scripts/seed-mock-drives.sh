#!/usr/bin/env bash
# Seed Luna's upgraded mock-drive system and scrub the legacy forced 64GB PSSD.
#
# Unique presets only (skip aliases: docs / code / all).
# Safe to re-run: existing drives are plugged; missing ones are spawned.
# Photos/mixed are refreshed when fixtures/mock-pssd/.seed-version changes
# (or when a drive still has the old synthetic stub photos).
#
# After refreshing photo fixtures, this script asks a running lunad to rescan
# the gallery (`POST /api/v1/gallery/rescan`). If lunad is not up, restart it
# (or open Photos → Look again) so new pictures show up.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${LUNA_DATA_DIR:-${ROOT}/dev}"
export LUNA_DATA_DIR="${DATA_DIR}"
PHOTO_SEED="${ROOT}/fixtures/mock-pssd/.seed-version"
LUNA_URL="${LUNA_URL:-http://127.0.0.1:${LUNA_PORT:-8090}}"
PHOTO_REFRESHED=0

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

# Ask a running lunad to re-index photos. Uses the same default desktop user as
# companion rapid-dev; override with LUNA_DEV_USER / LUNA_DEV_PASS if needed.
notify_gallery_rescan() {
  local url="$1"
  if ! curl -fsS -o /dev/null --connect-timeout 1 "${url}/health" 2>/dev/null; then
    echo ">> lunad is not running at ${url}"
    echo "   Start or restart it so Photos picks up the new fixtures:"
    echo "     cd ${ROOT} && make daemon-dev"
    echo "   Or open Photos and tap Look again once lunad is up."
    return 0
  fi

  local user="${LUNA_DEV_USER:-${LUNA_DESKTOP_DEV_USER:-desktop}}"
  local pass="${LUNA_DEV_PASS:-${LUNA_DESKTOP_DEV_PASS:-hunter22hunter1}}"
  local cookie_jar
  cookie_jar="$(mktemp)"
  cleanup_cookie() { rm -f "${cookie_jar}"; }
  trap cleanup_cookie RETURN

  if ! curl -fsS -c "${cookie_jar}" -b "${cookie_jar}" \
    -X POST "${url}/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${user}\",\"password\":\"${pass}\"}" >/dev/null 2>&1; then
    echo ">> Could not sign in to lunad as ${user} to request a gallery rescan."
    echo "   Open Photos → Look again, or restart lunad, after seeding."
    return 0
  fi

  local csrf
  csrf="$(awk '/luna_csrf/ {print $NF}' "${cookie_jar}" | tail -1)"
  if [ -z "${csrf}" ]; then
    echo ">> Login succeeded but no CSRF cookie — restart lunad or use Photos → Look again."
    return 0
  fi

  if curl -fsS -c "${cookie_jar}" -b "${cookie_jar}" \
    -X POST "${url}/api/v1/gallery/rescan" \
    -H 'Content-Type: application/json' \
    -H "X-CSRF-Token: ${csrf}" \
    -d '{}' >/dev/null 2>&1; then
    echo ">> Asked lunad to look through drives again (gallery rescan queued)."
  else
    echo ">> Gallery rescan request failed. Fallback: open Photos → Look again, or restart lunad."
  fi
}

echo ">> Seeding mock drives under ${DATA_DIR}/mock-drives"
for preset in photos documents media projects deep mixed empty; do
  drive="${DATA_DIR}/mock-drives/${preset}"
  if [ "${preset}" = "photos" ] || [ "${preset}" = "mixed" ]; then
    if needs_photo_refresh "${drive}"; then
      echo ">> Refreshing ${preset} drive from photo fixtures"
      (cd "${ROOT}" && make mock-drive ARGS="delete ${preset}") || true
      (cd "${ROOT}" && make mock-drive ARGS="spawn ${preset} ${preset}")
      PHOTO_REFRESHED=1
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

if [ "${PHOTO_REFRESHED}" = "1" ]; then
  notify_gallery_rescan "${LUNA_URL}"
fi
