#!/usr/bin/env bash
# docs-bot daily loop. PID 1. 04:00 America/Los_Angeles every day.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
export TZ="${TZ:-America/Los_Angeles}"
COOK="${HERE}/cook.sh"
log() { printf '%s docs-bot %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"; }

run_once() {
  log "cook start"
  if [ -x "$COOK" ]; then
    if "$COOK"; then
      log "cook ok"
    else
      log "cook failed rc=$?"
    fi
  else
    log "cook.sh missing or not executable"
  fi
}

if [ "${DOCS_RUN_NOW:-}" = "1" ]; then
  run_once
fi

while true; do
  now_h=$(date +%H)
  now_m=$(date +%M)
  if [ "$now_h" = "04" ] && [ "$now_m" = "00" ]; then
    stamp="$(date +%Y%m%d)"
    lastf="${HERE}/.last-run-day"
    last=""
    [ -f "$lastf" ] && last=$(cat "$lastf")
    if [ "$last" != "$stamp" ]; then
      echo "$stamp" > "$lastf"
      run_once
    fi
  fi
  sleep 30
done
