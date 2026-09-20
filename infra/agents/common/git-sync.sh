#!/usr/bin/env bash
# Shared LibreServ force-pull. Never echo the token. Operate only inside dest.
# Never touch /data/cargo or /data/rustup.

sync_libreserv() {
  local token="${1:-}"
  if [ -z "${token}" ]; then
    echo "sync_libreserv: token required" >&2
    return 2
  fi
  local dest="${BOT_REPO_DIR:-/data/LibreServ}"
  local base="${FORGEJO_URL:-https://gt.plainskill.net}"
  local org="${BOT_ORG:-LibreLoom}"
  local repo="${BOT_REPO:-LibreServ}"
  local branch="${BOT_BRANCH:-main}"
  local host="${base#https://}"
  host="${host#http://}"
  host="${host%%/*}"
  local url="https://oauth2:${token}@${host}/${org}/${repo}.git"
  local public="${base}/${org}/${repo}.git"

  case "${dest}" in
    /data/cargo|/data/cargo/*|/data/rustup|/data/rustup/*)
      echo "sync_libreserv: refusing dest=${dest}" >&2
      return 2
      ;;
  esac
  case "${dest}" in
    /*) ;;
    *)
      echo "sync_libreserv: dest must be absolute" >&2
      return 2
      ;;
  esac

  export GIT_TERMINAL_PROMPT=0
  if [ ! -d "${dest}/.git" ]; then
    mkdir -p "$(dirname "${dest}")"
    echo "sync_libreserv: clone ${org}/${repo} -> ${dest}"
    git clone --depth 50 "${url}" "${dest}"
  fi
  (
    cd "${dest}" || exit 2
    git remote set-url origin "${url}"
    git fetch --depth 50 origin "${branch}"
    git checkout -B "${branch}" "origin/${branch}"
    git reset --hard "origin/${branch}"
    git clean -fd
    git remote set-url origin "${public}"
    echo "sync_libreserv: ${org}/${repo} ${branch} $(git rev-parse --short HEAD)"
  )
}
