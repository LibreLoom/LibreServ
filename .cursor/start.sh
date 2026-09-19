#!/usr/bin/env bash
# Cloud Agent per-boot setup for LibreServ.
#
# Starts the Podman API socket (needed even when systemd user bus is missing),
# then authenticates fj for Forgejo comments/issues. Does not change git remotes;
# Cursor keeps the default remote for whichever host the agent spawned from.
#
# Forgejo auth requires the FORGEJO_TOKEN secret (Cursor Secrets panel). Without
# it, fj stays unauthenticated; Podman still starts.
set -euo pipefail

# ── Podman API socket (always; independent of Forgejo) ───────────────────────
# Cloud Agent images often have no user systemd bus, so `systemctl --user
# start podman.socket` fails. Fall back to `podman system service`.
start_podman() {
  if ! command -v podman >/dev/null 2>&1; then
    echo ">> podman not installed — skip socket (install.sh should have added it)"
    return 0
  fi

  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  mkdir -p "${XDG_RUNTIME_DIR}/podman" 2>/dev/null \
    || sudo mkdir -p "${XDG_RUNTIME_DIR}/podman"
  sudo chown "$(id -u):$(id -g)" "${XDG_RUNTIME_DIR}" "${XDG_RUNTIME_DIR}/podman" 2>/dev/null || true

  local sock="${XDG_RUNTIME_DIR}/podman/podman.sock"
  export DOCKER_HOST="unix://${sock}"

  if [ -S "${sock}" ]; then
    echo ">> Podman socket already up: ${sock}"
    return 0
  fi

  if systemctl --user start podman.socket >/dev/null 2>&1; then
    echo ">> Started podman.socket via user systemd"
    return 0
  fi

  echo ">> Starting podman system service on ${sock}"
  nohup podman system service --time=0 "unix://${sock}" \
    >/tmp/podman-system-service.log 2>&1 &
  local i
  for i in $(seq 1 25); do
    if [ -S "${sock}" ]; then
      echo ">> Podman socket ready: ${sock}"
      return 0
    fi
    sleep 0.2
  done
  echo ">> Podman socket did not appear (see /tmp/podman-system-service.log)"
}
start_podman

# Luna Photos (Places map) added react-leaflet after some env snapshots were built;
# sync web deps when the lockfile is newer than node_modules.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LUNA_WEB="${REPO_ROOT}/luna/web"
if [ -f "${LUNA_WEB}/package-lock.json" ]; then
  if [ ! -d "${LUNA_WEB}/node_modules/react-leaflet" ] \
    || [ "${LUNA_WEB}/package-lock.json" -nt "${LUNA_WEB}/node_modules/.package-lock.json" ]; then
    echo ">> Syncing luna/web npm dependencies"
    (cd "${LUNA_WEB}" && npm ci --prefer-offline --no-audit --no-fund)
  fi
fi

# Ensure mock-drive presets are present/plugged (seeded by .cursor/install.sh;
# re-plug any that a previous session left unplugged). Same path resolution as
# mock-drive.py; .drive.json marks a completed spawn — a dir without it is a
# partial spawn and gets respawned.
export LUNA_DATA_DIR="${LUNA_DATA_DIR:-${REPO_ROOT}/luna/dev}"
MOCK_DRIVES="${LUNA_MOCK_DRIVES_PATH:-${LUNA_DATA_DIR}/mock-drives}"
for preset in photos documents media projects deep mixed empty; do
  drive="${MOCK_DRIVES}/${preset}"
  if [ -d "${drive}" ] && [ -f "${drive}/.unplugged" ]; then
    (cd "${REPO_ROOT}/luna" && make mock-drive ARGS="plug ${preset}") || true
  elif [ ! -f "${drive}/.drive.json" ]; then
    (cd "${REPO_ROOT}/luna" && make mock-drive ARGS="spawn ${preset} ${preset}") \
      || echo ">> mock-drive spawn ${preset} failed (non-fatal)"
  fi
done

# Scrub the legacy pre-preset mock drive (superseded by mock-drives/ presets).
rm -rf "${LUNA_DATA_DIR}/mock-pssd-vol"
if [ -f "${LUNA_DATA_DIR}/luna.db" ]; then
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
if ids:
    print(f">> Removed {len(ids)} legacy sdmock drive row(s) from luna.db")
PY
fi

# Luna Connect mock: cloud backup unlocked + domain hostname + device-token so
# External Services UI shows (connect_active). lunad terminals must set
# LUNA_CONNECT_URL=http://127.0.0.1:18765 (see environment.json).
if [ -f "${REPO_ROOT}/luna/scripts/seed-mock-connect.sh" ]; then
  chmod +x "${REPO_ROOT}/luna/scripts/seed-mock-connect.sh"
  bash "${REPO_ROOT}/luna/scripts/seed-mock-connect.sh" || echo ">> seed-mock-connect.sh failed (non-fatal)"
fi

FORGE_HOST="gt.plainskill.net"

install_fj_wrapper() {
  local repo_root real wrapper dest
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  real="/usr/local/libexec/fj"
  wrapper="${repo_root}/.cursor/fj-wrapper.sh"
  dest="/usr/local/bin/fj"

  [ -x "${wrapper}" ] || return 0
  command -v fj >/dev/null 2>&1 || [ -x "${dest}" ] || [ -x "${real}" ] || return 0

  as_root() {
    if [ "$(id -u)" -eq 0 ]; then
      "$@"
    else
      sudo "$@"
    fi
  }

  as_root mkdir -p /usr/local/libexec
  if [ -x "${dest}" ] && [ ! -x "${real}" ]; then
    # First boot after an install that dropped the binary at /usr/local/bin/fj.
    if ! as_root head -n 1 "${dest}" 2>/dev/null | grep -q bash; then
      as_root mv "${dest}" "${real}"
    fi
  fi
  as_root install -m 0755 "${wrapper}" "${dest}"
}

install_fj_wrapper

if [ -z "${FORGEJO_TOKEN:-}" ]; then
  echo ">> FORGEJO_TOKEN not set — skipping fj auth."
  echo "   Add FORGEJO_TOKEN in the Cursor Secrets panel to use fj with ${FORGE_HOST}."
  exit 0
fi

if command -v fj >/dev/null 2>&1 || [ -x /usr/local/libexec/fj ]; then
  printf '%s' "${FORGEJO_TOKEN}" | fj auth add-token -H "${FORGE_HOST}" >/dev/null 2>&1 \
    && echo ">> fj authenticated for ${FORGE_HOST} (LibreLoom/LibreServ)" \
    || echo ">> fj auth skipped (could not add token)"
else
  echo ">> fj not installed — skip auth"
fi
