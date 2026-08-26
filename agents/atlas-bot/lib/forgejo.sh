#!/usr/bin/env bash
# Tiny Forgejo REST helpers. Never print the token.
# Always authenticate as atlas-bot. Never the Actions token (that
# posts as forgejo-actions).
set -euo pipefail
FORGEJO_URL="${FORGEJO_URL:-https://gt.plainskill.net}"
if [[ -z "${ATLAS_BOT_TOKEN:-}" ]]; then
  echo "forgejo.sh: ATLAS_BOT_TOKEN is required (will not fall back to FORGEJO_TOKEN)" >&2
  exit 2
fi
TOKEN="${ATLAS_BOT_TOKEN}"

api() {
  local method="$1"; shift
  local attempt=1
  local max="${ATLAS_API_RETRIES:-3}"
  local out err rc
  while true; do
    err="$(mktemp /tmp/atlas-curl-XXXXXX)"
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
    echo "==> forgejo ${method} failed rc=${rc} try=${attempt}/$( [[ $attempt -lt $max ]] && echo $max || echo $max ) $(tr '\n' ' ' < "${err}" | tail -c 200)" >&2
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
  parent_file="$(mktemp /tmp/atlas-parent-XXXXXX)"
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
