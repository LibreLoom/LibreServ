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
