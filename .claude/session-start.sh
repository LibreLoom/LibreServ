#!/usr/bin/env bash
# SessionStart hook for Claude Code cloud sessions (wired in .claude/settings.json).
#
# Counterpart of .cursor/start.sh plus the checkout-dependent half of
# .cursor/install.sh. Machine toolchains come from the environment's setup
# script (.claude/cloud-setup.sh), which is cached and so can't see this
# session's checkout. Local sessions exit immediately.
#
# Fast, per-session state runs inline: env vars, Podman API socket, fj,
# backend config, Luna mock drives + mock Connect. The slow part (npm ci,
# builds, lunad) runs in the background so the session starts right away;
# progress goes to $LOG, and $STATE ends as "done" or "failed".
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG=/tmp/libreserv-session-setup.log
STATE=/tmp/libreserv-session-setup.state

# ── Environment for every command Claude runs ────────────────────────────────
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/podman/podman.sock"
export ANDROID_HOME=/usr/local/android-sdk
export ANDROID_SDK_ROOT="${ANDROID_HOME}"
export LUNA_DATA_DIR="${REPO}/luna/dev"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}"
    echo "export DOCKER_HOST=${DOCKER_HOST}"
    echo "export ANDROID_HOME=${ANDROID_HOME}"
    echo "export ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT}"
    echo "export PATH=\"\${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools\""
  } >>"${CLAUDE_ENV_FILE}"
fi
[ -d "${ANDROID_HOME}" ] && echo "sdk.dir=${ANDROID_HOME}" >"${REPO}/luna/mobile/local.properties"

# ── Podman API socket (./ci talks to it via DOCKER_HOST) ─────────────────────
if command -v podman >/dev/null 2>&1; then
  mkdir -p "${XDG_RUNTIME_DIR}/podman"
  if [ ! -S "${XDG_RUNTIME_DIR}/podman/podman.sock" ]; then
    nohup podman system service --time=0 "${DOCKER_HOST}" \
      >/tmp/podman-system-service.log 2>&1 &
  fi
fi

# ── fj (Forgejo CLI) ─────────────────────────────────────────────────────────
# The binary comes from the setup script; the wrapper pins LibreLoom/LibreServ.
# The real token is an environment API credential that the agent proxy adds to
# requests for gt.plainskill.net, so fj only needs a stored placeholder.
if [ -x /usr/local/libexec/fj ]; then
  install -m 0755 "${REPO}/.cursor/fj-wrapper.sh" /usr/local/bin/fj
  printf '%s' "${FORGEJO_TOKEN:-injected-by-agent-proxy}" \
    | fj auth add-token -H gt.plainskill.net >/dev/null 2>&1 || true
fi

# ── Backend config ───────────────────────────────────────────────────────────
cfg="${REPO}/sol/server/backend/configs/libreserv.yaml"
[ -f "${cfg}" ] || cp "${cfg}.example" "${cfg}"

# ── Luna mock drives + mock Connect ──────────────────────────────────────────
for preset in photos documents media projects deep mixed empty; do
  drive="${LUNA_DATA_DIR}/mock-drives/${preset}"
  if [ -f "${drive}/.drive.json" ]; then
    make -C "${REPO}/luna" mock-drive ARGS="plug ${preset}" >/dev/null 2>&1 || true
  else
    make -C "${REPO}/luna" mock-drive ARGS="spawn ${preset} ${preset}" >/dev/null 2>&1 || true
  fi
done
bash "${REPO}/luna/scripts/mocks/seed-mock-connect.sh" >/dev/null 2>&1 \
  || echo "Luna mock Connect failed to start; run: bash luna/scripts/mocks/seed-mock-connect.sh"

# ── Dependencies and builds (background) ─────────────────────────────────────
# npm ci only when the lockfile changed since the last install.
npm_ci() {
  local dir="$1"
  if [ ! -f "${dir}/node_modules/.package-lock.json" ] \
    || [ "${dir}/package-lock.json" -nt "${dir}/node_modules/.package-lock.json" ]; then
    (cd "${dir}" && npm ci --no-audit --no-fund)
  fi
}

build_all() {
  set -e
  echo ">> go mod download"
  (cd "${REPO}/sol/server/backend" && go mod download)
  [ -x "${REPO}/sol/server/backend/OS/bin/restic" ] \
    || make -C "${REPO}/sol/server/backend" restic-fetch \
    || echo ">> restic fetch skipped (backups use the tar fallback)"

  echo ">> npm ci (shared/ui, sol frontend, luna web)"
  npm_ci "${REPO}/shared/ui"
  npm_ci "${REPO}/sol/server/frontend"
  npm_ci "${REPO}/luna/web"

  echo ">> Building sol frontend and luna web"
  (cd "${REPO}/sol/server/frontend" && npm run build)
  # lunad embeds luna/web/dist at compile time, so web must build first.
  (cd "${REPO}/luna/web" && npm run build)

  echo ">> Building lunad"
  make -C "${REPO}/luna" build-daemon
}

if [ "$(cat "${STATE}" 2>/dev/null)" != "running" ]; then
  echo running >"${STATE}"
  nohup bash -c "$(declare -f npm_ci build_all); REPO='${REPO}'; \
    if build_all; then echo done >'${STATE}'; else echo failed >'${STATE}'; fi" \
    >"${LOG}" 2>&1 &
fi

# Shown to Claude at session start.
cat <<EOF
LibreServ session setup: npm deps, frontend builds, and lunad are building in
the background (log: ${LOG}; ${STATE} reads running/done/failed). Wait for
"done" before running builds, tests, or ./ci. Podman socket: ${DOCKER_HOST}.
Luna mock Connect is on http://127.0.0.1:18765; start lunad with
LUNA_CONNECT_URL=http://127.0.0.1:18765 make -C luna dev-daemon.
EOF
exit 0
