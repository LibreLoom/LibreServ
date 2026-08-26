#!/usr/bin/env bash
# docs-bot scheduled cook. No event payload. No mention webhook.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
export TZ="${TZ:-America/Los_Angeles}"
export RUSTUP_HOME="${RUSTUP_HOME:-/data/rustup}"
export CARGO_HOME="${CARGO_HOME:-/data/cargo}"
export PATH="/data/cargo/bin:/usr/local/cargo/bin:/home/atlas/.cargo/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

if [ -z "${DOCS_BOT_TOKEN:-}" ]; then
  echo "cook.sh: DOCS_BOT_TOKEN is required (will not use ATLAS_BOT_TOKEN)" >&2
  exit 2
fi
if [ -n "${ATLAS_BOT_TOKEN:-}" ]; then
  echo "cook.sh: unsetting ATLAS_BOT_TOKEN (this is docs-bot)" >&2
  unset ATLAS_BOT_TOKEN
fi

BOT_REPO_DIR="${BOT_REPO_DIR:-/data/LibreServ}"
if [ "${BOT_ALREADY_SYNCED:-}" != "1" ]; then
  COMMON="${BOT_REPO_DIR}/agents/common/git-sync.sh"
  if [ -f "${COMMON}" ]; then
    # shellcheck disable=SC1091
    . "${COMMON}"
    sync_libreserv "${DOCS_BOT_TOKEN}"
  else
    host="${FORGEJO_URL:-https://gt.plainskill.net}"
    host="${host#https://}"; host="${host#http://}"; host="${host%%/*}"
    export GIT_TERMINAL_PROMPT=0
    url="https://oauth2:${DOCS_BOT_TOKEN}@${host}/LibreLoom/LibreServ.git"
    if [ ! -d "${BOT_REPO_DIR}/.git" ]; then
      git clone --depth 50 "${url}" "${BOT_REPO_DIR}"
    fi
    git -C "${BOT_REPO_DIR}" remote set-url origin "${url}"
    git -C "${BOT_REPO_DIR}" fetch --depth 50 origin main
    git -C "${BOT_REPO_DIR}" checkout -B main origin/main
    git -C "${BOT_REPO_DIR}" reset --hard origin/main
    git -C "${BOT_REPO_DIR}" clean -fd
  fi
  export BOT_ALREADY_SYNCED=1
  NEW="${BOT_REPO_DIR}/agents/docs-bot/cook.sh"
  self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  target="$(readlink -f "${NEW}" 2>/dev/null || echo "${NEW}")"
  if [ -x "${NEW}" ] && [ "${self}" != "${target}" ]; then
    echo "==> docs-bot exec ${NEW}"
    exec /bin/bash "${NEW}" "$@"
  fi
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${DOCS_GITHUB_TOKEN:-}" ]; then
  export GITHUB_TOKEN="${DOCS_GITHUB_TOKEN}"
else
  unset GITHUB_TOKEN || true
fi

export FORGEJO_URL="${FORGEJO_URL:-https://gt.plainskill.net}"
export FORGEJO_TOKEN="${DOCS_BOT_TOKEN}"
export FORGEJO_BASE="${FORGEJO_URL}"
export FJ_TOKEN="${DOCS_BOT_TOKEN}"
# shellcheck disable=SC1091
. "${HERE}/lib/forgejo.sh"

ORG="${DOCS_ORG:-LibreLoom}"
REPO="${DOCS_REPO:-LibreServ}"
DAY="${DAY:-$(date +%Y%m%d)}"
