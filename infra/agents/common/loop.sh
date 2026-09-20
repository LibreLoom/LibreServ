#!/usr/bin/env bash
# Scheduled bot loop. PID 1. Runs cook.sh once a day at BOT_SCHEDULE_HOUR
# (America/Los_Angeles). Agent code comes from a force-pulled clone,
# not a bind-mount.
#
# Required env: BOT_NAME (e.g. "docs-bot"). Optional: BOT_SCHEDULE_HOUR
# (default 04), <NAME>_RUN_NOW=1 to run immediately on boot (NAME is
# BOT_NAME uppercased without the -bot suffix — docs-bot -> DOCS_RUN_NOW).
set -eu
export TZ="${TZ:-America/Los_Angeles}"
export BOT_REPO_DIR="${BOT_REPO_DIR:-/data/LibreServ}"

if [ -z "${BOT_NAME:-}" ]; then
  echo "loop.sh: BOT_NAME is required" >&2
  exit 2
fi
BOT_SLUG="$(echo "${BOT_NAME}" | tr '[:lower:]-' '[:upper:]_')"          # docs-bot -> DOCS_BOT
BOT_SHORT="$(echo "${BOT_SLUG}" | sed 's/_BOT$//')"                     # docs-bot -> DOCS
TOKEN_VAR="${BOT_SLUG}_TOKEN"
RUN_NOW_VAR="${BOT_SHORT}_RUN_NOW"
SCHEDULE_HOUR="${BOT_SCHEDULE_HOUR:-04}"

log() { printf '%s %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "${BOT_NAME}" "$*"; }

sync_clone() {
  eval "token=\"\${${TOKEN_VAR}:-}\""
  if [ -z "${token}" ]; then
    log "${TOKEN_VAR} missing"
    return 2
  fi
  GIT_SYNC="${BOT_REPO_DIR}/infra/agents/common/git-sync.sh"
  if [ -f "${GIT_SYNC}" ]; then
    # shellcheck disable=SC1091
    . "${GIT_SYNC}"
    sync_libreserv "${token}"
  else
    host="${FORGEJO_URL:-https://gt.plainskill.net}"
    host="${host#https://}"; host="${host#http://}"; host="${host%%/*}"
    if [ ! -d "${BOT_REPO_DIR}/.git" ]; then
      GIT_TERMINAL_PROMPT=0 git clone --depth 50 \
        "https://oauth2:${token}@${host}/LibreLoom/LibreServ.git" "${BOT_REPO_DIR}"
    fi
    git -C "${BOT_REPO_DIR}" fetch --depth 50 origin main
    git -C "${BOT_REPO_DIR}" reset --hard origin/main
    git -C "${BOT_REPO_DIR}" clean -fd
  fi
}

run_once() {
  log "sync"
  if ! sync_clone; then
    log "sync failed"
    return 2
  fi
  COOK="${BOT_REPO_DIR}/infra/agents/${BOT_NAME}/cook.sh"
  log "cook start ${COOK}"
  if [ -f "${COOK}" ]; then
    if BOT_ALREADY_SYNCED=1 /bin/bash "${COOK}"; then
      log "cook ok"
    else
      log "cook failed rc=$?"
    fi
  else
    log "cook.sh missing"
  fi
}

run_now="$(eval "echo \"\${${RUN_NOW_VAR}:-}\"")"
if [ "${run_now}" = "1" ]; then
  run_once
fi

while true; do
  now_h=$(date +%H)
  now_m=$(date +%M)
  if [ "$now_h" = "${SCHEDULE_HOUR}" ] && [ "$now_m" = "00" ]; then
    stamp="$(date +%Y%m%d)"
    lastf="/data/.last-run-day-${BOT_NAME}"
    last=""
    [ -f "$lastf" ] && last=$(cat "$lastf")
    if [ "$last" != "$stamp" ]; then
      echo "$stamp" > "$lastf"
      run_once
    fi
  fi
  sleep 30
done
