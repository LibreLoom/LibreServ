#!/usr/bin/env bash
# Tiny Forgejo REST helpers. Never print the token.
set -euo pipefail
FORGEJO_URL="${FORGEJO_URL:-https://gt.plainskill.net}"
TOKEN="${ATLAS_BOT_TOKEN:-${FORGEJO_TOKEN:-}}"
api() {
  local method="$1"; shift
  curl -fsS -X "${method}" \
    -H "Authorization: token ${TOKEN}" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    "$@"
}

fj_comment() {
  local owner="$1" repo="$2" index="$3" body="$4"
  python3 -c "import json,sys; print(json.dumps({'body': sys.argv[1]}))" "${body}" | \
    api POST "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/issues/${index}/comments" -d @-
}

fj_unassign() {
  local owner="$1" repo="$2" index="$3" user="$4"
  python3 -c "import json,sys; print(json.dumps({'assignees':[sys.argv[1]]}))" "${user}" | \
    api DELETE "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/issues/${index}/assignees" -d @- || true
}
