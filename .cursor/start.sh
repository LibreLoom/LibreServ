#!/usr/bin/env bash
# Cloud Agent per-boot Forgejo CLI auth for LibreServ.
#
# Does not change git remotes. Cursor keeps the default remote for whichever
# host the agent spawned from. This only authenticates fj (installed by
# install.sh) and ensures the wrapper pins Forgejo host/repo for comments
# and issues.
#
# Requires the FORGEJO_TOKEN secret (Cursor Secrets panel). Without it this is
# a clean no-op so the environment still starts normally.
set -euo pipefail

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
