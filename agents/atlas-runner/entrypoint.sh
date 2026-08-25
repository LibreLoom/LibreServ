#!/usr/bin/env bash
set -euo pipefail
MODE="${ATLAS_MODE:-both}"

if [[ -z "${ATLAS_BOT_TOKEN:-}" ]]; then
  echo "ATLAS_BOT_TOKEN is required" >&2
  exit 1
fi
if [[ -z "${AI_PROXY_API_KEY:-}" ]]; then
  echo "AI_PROXY_API_KEY is required" >&2
  exit 1
fi

if [[ "${MODE}" == "intake" || "${MODE}" == "both" ]]; then
  python3 /opt/atlas-bot/intake/server.py &
  echo "==> intake on :${ATLAS_INTAKE_PORT:-8787}"
fi

if [[ "${MODE}" == "runner" || "${MODE}" == "both" ]]; then
  if [[ ! -f /data/.runner ]]; then
    echo "==> /data/.runner missing. Register first (see agents/atlas-runner/README.md) then restart."
    if [[ "${MODE}" == "runner" ]]; then
      exit 1
    fi
    wait
    exit 0
  fi
  exec forgejo-runner daemon --config /opt/atlas-runner/config.yaml
fi
wait
