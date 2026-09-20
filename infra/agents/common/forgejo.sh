#!/usr/bin/env bash
# Tiny Forgejo REST helpers shared by all bots. Never print the token.
# Always authenticate as the calling bot — never the Actions token (that
# posts as forgejo-actions).
#
# Requires BOT_NAME (e.g. "atlas-bot"). Reads the token from the per-bot
# env var derived from it: atlas-bot -> ATLAS_BOT_TOKEN, docs-bot ->
# DOCS_BOT_TOKEN, lock-bot -> LOCK_BOT_TOKEN.
set -euo pipefail
FORGEJO_URL="${FORGEJO_URL:-https://gt.plainskill.net}"

if [[ -z "${BOT_NAME:-}" ]]; then
  echo "forgejo.sh: BOT_NAME is required (set it before sourcing)" >&2
  exit 2
fi
TOKEN_VAR="$(echo "${BOT_NAME}" | tr '[:lower:]-' '[:upper:]_')_TOKEN"
if [[ -z "${!TOKEN_VAR:-}" ]]; then
  echo "forgejo.sh: ${TOKEN_VAR} is required (will not fall back to FORGEJO_TOKEN)" >&2
  exit 2
fi
TOKEN="${!TOKEN_VAR}"

api() {
  local method="$1"; shift
  local attempt=1
  local retries_var
  retries_var="$(echo "${BOT_NAME}" | tr '[:lower:]-' '[:upper:]_')_API_RETRIES"
  local max="${!retries_var:-3}"
  local out err rc
  while true; do
    err="$(mktemp "/tmp/${BOT_NAME}-curl-XXXXXX")"
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

fj_edit_comment() {
  local owner="$1" repo="$2" comment_id="$3" body="$4"
  if [[ -z "${comment_id}" || "${comment_id}" == "0" ]]; then
    return 0
  fi
  # PATCH errors must propagate (curl -f in api). Do not swallow.
  python3 -c "import json,sys; print(json.dumps({'body': sys.argv[1]}))" "${body}" | \
    api PATCH "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/issues/comments/${comment_id}" -d @- >/dev/null
}

fj_get_comment() {
  local owner="$1" repo="$2" comment_id="$3"
  api GET "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/issues/comments/${comment_id}"
}

fj_list_open_prs() {
  local owner="$1" repo="$2"
  api GET "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/pulls?state=open&limit=50"
}

# Prints the new PR's html_url (falls back to api url).
fj_create_pr() {
  local owner="$1" repo="$2" head="$3" base="$4" title="$5" body="$6"
  python3 -c "import json,sys; print(json.dumps({'title': sys.argv[1], 'body': sys.argv[2], 'head': sys.argv[3], 'base': sys.argv[4]}))" \
    "${title}" "${body}" "${head}" "${base}" | \
    api POST "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/pulls" -d @- | \
    python3 -c "import json,sys; p=json.load(sys.stdin); print(p.get('html_url') or p.get('url') or '')"
}

# Quote-reply: Forgejo CreateIssueCommentOption only has body (no reply_to).
# GET the parent, then POST the standard Gitea/Forgejo quote-reply body.
# Prints the new comment id.
fj_comment_reply() {
  local owner="$1" repo="$2" index="$3" reply_to_id="$4" body="$5"
  local parent payload parent_file
  if [[ -z "${reply_to_id}" || "${reply_to_id}" == "0" || "${reply_to_id}" == "None" ]]; then
    fj_comment "${owner}" "${repo}" "${index}" "${body}"
    return
  fi
  local get_rc=0
  set +e
  parent="$(fj_get_comment "${owner}" "${repo}" "${reply_to_id}")"
  get_rc=$?
  set -e
  if [[ ${get_rc} -ne 0 || -z "${parent}" ]]; then
    echo "==> comment_reply: GET parent ${reply_to_id} failed; posting unquoted" >&2
    fj_comment "${owner}" "${repo}" "${index}" "${body}"
    return
  fi
  parent_file="$(mktemp "/tmp/${BOT_NAME}-parent-XXXXXX")"
  printf '%s' "${parent}" > "${parent_file}"
  payload="$(python3 - "${parent_file}" "${body}" "${FORGEJO_URL}" "${owner}" "${repo}" "${index}" "${reply_to_id}" <<'PY'
import json, pathlib, sys

parent_path, body, base, owner, repo, index, cid = sys.argv[1:8]
try:
    parent = json.loads(pathlib.Path(parent_path).read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    parent = {}
if not isinstance(parent, dict):
    parent = {}

login = ((parent.get("user") or {}).get("login") or "").strip()
html_url = (parent.get("html_url") or "").strip()
if not html_url:
    html_url = f"{base.rstrip('/')}/{owner}/{repo}/issues/{index}#issuecomment-{cid}"

src = (parent.get("body") or "").replace("\r\n", "\n").replace("\r", "\n")
lines = src.split("\n")
truncated = False
if len(lines) > 30:
    lines = lines[:30]
    truncated = True
quoted_lines = [("> " + line) if line else ">" for line in lines]
quoted = "\n".join(quoted_lines)
if len(quoted) > 1500:
    quoted = quoted[:1500].rsplit("\n", 1)[0]
    truncated = True
if truncated:
    if quoted and not quoted.endswith("\n"):
        quoted += "\n"
    quoted += "> …"
if not quoted:
    quoted = ">"

if login:
    out = f"@{login} wrote in {html_url}:\n\n{quoted}\n\n{body}"
else:
    out = body
print(json.dumps({"body": out}))
PY
)"
  rm -f "${parent_file}"
  printf '%s' "${payload}" | \
    api POST "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/issues/${index}/comments" -d @- | \
    python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))"
}

fj_unassign() {
  local owner="$1" repo="$2" index="$3" user="$4"
  python3 -c "import json,sys; print(json.dumps({'assignees':[sys.argv[1]]}))" "${user}" | \
    api DELETE "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/issues/${index}/assignees" -d @- || true
}

fj_react_comment() {
  local owner="$1" repo="$2" comment_id="$3" emoji="${4:-eyes}"
  if [[ -z "${comment_id}" || "${comment_id}" == "0" || "${comment_id}" == "None" ]]; then
    return 0
  fi
  python3 -c "import json,sys; print(json.dumps({'content': sys.argv[1]}))" "${emoji}" | \
    api POST "${FORGEJO_URL}/api/v1/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions" -d @- || true
}
