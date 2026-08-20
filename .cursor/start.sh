#!/usr/bin/env bash
# Cloud Agent per-boot Forgejo wiring for LibreServ.
#
# LibreServ is developed on Forgejo (gt.plainskill.net); the GitHub repo is a
# mirror. This points every fresh Cloud Agent at Forgejo for git and authenticates
# the fj CLI, so agents push and open PRs on Forgejo.
#
# Requires the FORGEJO_TOKEN secret (Cursor Secrets panel). Without it this is a
# clean no-op so the environment still starts normally on the GitHub remote.
set -euo pipefail

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
