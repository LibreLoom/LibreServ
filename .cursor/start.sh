#!/usr/bin/env bash
# Cloud Agent per-boot setup for LibreServ.
#
# Starts the Podman API socket (needed even when systemd user bus is missing),
# then wires git + fj to Forgejo (gt.plainskill.net). The GitHub repo is a
# mirror.
#
# Forgejo auth requires the FORGEJO_TOKEN secret (Cursor Secrets panel). Without
# it, git stays on the GitHub remote; Podman still starts.
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

FORGE_HOST="gt.plainskill.net"
FORGE_REPO="LibreLoom/LibreServ"
FORGE_URL="https://${FORGE_HOST}/${FORGE_REPO}.git"

if [ -z "${FORGEJO_TOKEN:-}" ]; then
  echo ">> FORGEJO_TOKEN not set — skipping Forgejo setup (git stays on the GitHub remote)."
  echo "   Add FORGEJO_TOKEN in the Cursor Secrets panel to use ${FORGE_HOST} + fj."
  exit 0
fi

# 1) git credentials via the store helper (token never lands in a remote URL).
git config --global credential.helper store
fj_user="$(curl -fsS -H "Authorization: token ${FORGEJO_TOKEN}" "https://${FORGE_HOST}/api/v1/user" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("login",""))' 2>/dev/null || true)"
[ -z "${fj_user}" ] && fj_user="oauth2"
umask 077
printf 'https://%s:%s@%s\n' "${fj_user}" "${FORGEJO_TOKEN}" "${FORGE_HOST}" > "${HOME}/.git-credentials"
chmod 600 "${HOME}/.git-credentials"

# 2) Authenticate the fj CLI (installed by install.sh). Token read from stdin.
if command -v fj >/dev/null 2>&1; then
  printf '%s' "${FORGEJO_TOKEN}" | fj auth add-token -H "${FORGE_HOST}" >/dev/null 2>&1 \
    && echo ">> fj authenticated for ${fj_user}@${FORGE_HOST}" \
    || echo ">> fj auth skipped (could not add token)"
fi

# 3) Point origin at Forgejo; preserve the GitHub mirror as the `github` remote.
if git rev-parse --git-dir >/dev/null 2>&1; then
  cur_origin="$(git remote get-url origin 2>/dev/null || echo "")"
  case "${cur_origin}" in
    *"${FORGE_HOST}"*)
      : # origin already points at Forgejo
      ;;
    *)
      if [ -n "${cur_origin}" ] && ! git remote get-url github >/dev/null 2>&1; then
        git remote rename origin github 2>/dev/null || true
      fi
      if git remote get-url origin >/dev/null 2>&1; then
        git remote set-url origin "${FORGE_URL}"
      else
        git remote add origin "${FORGE_URL}"
      fi
      ;;
  esac
  echo ">> git origin -> ${FORGE_URL} (GitHub mirror kept as 'github')"
fi

echo ">> Forgejo ready. Use: fj -H ${FORGE_HOST} <command>"
