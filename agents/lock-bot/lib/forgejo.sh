#!/usr/bin/env bash
# Tiny Forgejo REST helpers for lock-bot. Never print the token.
# Authenticate as lock-bot. Never the Actions token.
set -euo pipefail
FORGEJO_URL="${FORGEJO_URL:-https://gt.plainskill.net}"
if [[ -z "${LOCK_BOT_TOKEN:-}" ]]; then
  echo "forgejo.sh: LOCK_BOT_TOKEN is required (will not fall back to FORGEJO_TOKEN or ATLAS_BOT_TOKEN)" >&2
  exit 2
fi
TOKEN="${LOCK_BOT_TOKEN}"

api() {
  local method="$1"; shift
  local attempt=1
  local max="${LOCK_API_RETRIES:-3}"
  local out err rc
  while true; do
    err="$(mktemp /tmp/lock-curl-XXXXXX)"
    set +e
    out="$(curl -sS -f -X "${method}" \
      -H "Authorization: token ${TOKEN}" \
      -H "Accept: application/json" \
      -H "Content-Type: application/json" \
      --max-time 30 \
      "$@" 2>"${err}")"
    rc=$?
    set -e
    if [[ ${rc} -eq 0 ]]; then
      rm -f "${err}"
      printf '%s' "${out}"
      return 0
    fi
    echo "==> forgejo ${method} failed rc=${rc} try=${attempt}/${max} $(tr '\n' ' ' < "${err}" | tail -c 200)" >&2
    rm -f "${err}"
    if [[ ${attempt} -ge ${max} ]]; then
      return "${rc}"
    fi
    sleep $((attempt * 2))
    attempt=$((attempt + 1))
  done
}

fj_comment() {
  local owner="$1" repo="$2" index="$3" body="$4"
  python3 -c "import json,sys; print(json.dumps({'body': sys.argv[1]}))" "${body}" | \
    api POST "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/issues/${index}/comments" -d @- | \
    python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))"
}

fj_list_open_prs() {
  local owner="$1" repo="$2"
  api GET "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/pulls?state=open&limit=50"
}

fj_create_pr() {
  local owner="$1" repo="$2" head="$3" base="$4" title="$5" body="$6"
  python3 -c "import json,sys; print(json.dumps({'title': sys.argv[1], 'body': sys.argv[2], 'head': sys.argv[3], 'base': sys.argv[4]}))" \
    "${title}" "${body}" "${head}" "${base}" | \
    api POST "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/pulls" -d @- | \
    python3 -c "import json,sys; p=json.load(sys.stdin); print(p.get('html_url') or p.get('url') or '')"
}
