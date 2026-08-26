#!/usr/bin/env bash
# lock-bot daily loop. PID 1. 03:00 America/Los_Angeles every day.
# Agent code comes from a force-pulled clone, not a bind-mount.
set -eu
export TZ="${TZ:-America/Los_Angeles}"
export BOT_REPO_DIR="${BOT_REPO_DIR:-/data/LibreServ}"
log() { printf '%s lock-bot %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"; }

sync_clone() {
  if [ -z "${LOCK_BOT_TOKEN:-}" ]; then
    log "LOCK_BOT_TOKEN missing"
    return 2
  fi
  COMMON="${BOT_REPO_DIR}/agents/common/git-sync.sh"
  if [ -f "${COMMON}" ]; then
    # shellcheck disable=SC1091
    . "${COMMON}"
    sync_libreserv "${LOCK_BOT_TOKEN}"
  else
    host="${FORGEJO_URL:-https://gt.plainskill.net}"
    host="${host#https://}"; host="${host#http://}"; host="${host%%/*}"
    if [ ! -d "${BOT_REPO_DIR}/.git" ]; then
      GIT_TERMINAL_PROMPT=0 git clone --depth 50 \
        "https://oauth2:${LOCK_BOT_TOKEN}@${host}/LibreLoom/LibreServ.git" "${BOT_REPO_DIR}"
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
  COOK="${BOT_REPO_DIR}/agents/lock-bot/cook.sh"
  log "cook start ${COOK}"
  if [ -x "${COOK}" ]; then
    if BOT_ALREADY_SYNCED=1 "${COOK}"; then
      log "cook ok"
    else
      log "cook failed rc=$?"
    fi
  else
    log "cook.sh missing or not executable"
  fi
}

if [ "${LOCK_RUN_NOW:-}" = "1" ]; then
  run_once
fi

while true; do
  now_h=$(date +%H)
  now_m=$(date +%M)
  if [ "$now_h" = "03" ] && [ "$now_m" = "00" ]; then
    stamp="$(date +%Y%m%d)"
    lastf="/data/.last-run-day"
    last=""
    [ -f "$lastf" ] && last=$(cat "$lastf")
    if [ "$last" != "$stamp" ]; then
      echo "$stamp" > "$lastf"
      run_once
    fi
  fi
  sleep 30
done
