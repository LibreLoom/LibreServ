#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export DSH_HOME="${DSH_HOME:-${HERE}/dsh-home}"
export ATLAS_PROMPT_FILE="${HERE}/docs-updater-prompt.md"
FORGEJO_URL="${FORGEJO_URL:-https://gt.plainskill.net}"
OWNER="${ATLAS_ORG:-LibreLoom}"
REPO="${ATLAS_DOCS_REPO:-LibreServ}"
TOKEN="${ATLAS_BOT_TOKEN:-${FORGEJO_TOKEN:-}}"
host="${FORGEJO_URL#https://}"; host="${host#http://}"
workdir="$(mktemp -d /tmp/atlas-docs-XXXXXX)"
git clone --depth 50 "${FORGEJO_URL}/${OWNER}/${REPO}.git" "${workdir}/repo"
cd "${workdir}/repo"
git remote set-url origin "https://oauth2:${TOKEN}@${host}/${OWNER}/${REPO}.git"
git config user.name atlas-bot
git config user.email atlas-bot@noreply.localhost
dsh --profile headless "$(cat "${ATLAS_PROMPT_FILE}")"
