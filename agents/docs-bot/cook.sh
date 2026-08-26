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
DAY="$(date +%Y%m%d)"
JOBID="$(date +%H%M%S)"
DOCS_RESULT="${DOCS_RESULT:-/tmp/docs-result-${JOBID}.md}"
export DOCS_RESULT
: > "${DOCS_RESULT}"
INVENTORY="${INVENTORY:-/tmp/docs-skip-unused.json}"
WORKDIR="${BOT_REPO_DIR:-/data/LibreServ}"
DSH_LOG="/tmp/docs-dsh-${JOBID}.log"
SKIP_PATHS="/tmp/docs-skip-paths.txt"
OUTDATED="/tmp/docs-unused.txt"
DOCKER_NOTES="/tmp/docs-notes.txt"
: > "${SKIP_PATHS}"
: > "${OUTDATED}"
: > "${DOCKER_NOTES}"
host="${FORGEJO_URL#https://}"
host="${host#http://}"
host="${host%%/*}"
CLONE_TIMEOUT="${DOCS_CLONE_TIMEOUT:-60}"
MAIN_SHA=""
PIN_PR=""
BUMP_PR=""

redact_log() {
  python3 -c 'import os,sys
t=sys.stdin.read()
for k in ("DOCS_BOT_TOKEN","DOCS_GITHUB_TOKEN","GITHUB_TOKEN"):
    v=os.environ.get(k) or ""
    if v: t=t.replace(v,"***")
sys.stdout.write(t)'
}

git_identity() {
  git config user.name "docs-bot" || true
  git config user.email "docs-bot@plainskill.net" || true
}

result_written() {
  [ -n "${DOCS_RESULT:-}" ] && [ -f "${DOCS_RESULT}" ] || return 1
  python3 -c 'import pathlib,sys; t=pathlib.Path(sys.argv[1]).read_text(encoding="utf-8",errors="replace").strip(); raise SystemExit(0 if t else 1)' "${DOCS_RESULT}"
}

cleanup() {
  rc=$?
  if [ -n "${DSH_PID:-}" ]; then
    kill "${DSH_PID}" 2>/dev/null || true
  fi
  return 0
}
trap cleanup EXIT

echo "==> docs-bot cook ${DAY} job=${JOBID} org=${ORG} repo=${REPO}"
if [ ! -d "${WORKDIR}/.git" ]; then
  echo "==> clone missing ${WORKDIR}" >&2
  echo "clone missing" > "${DOCS_RESULT}"
  exit 2
fi
cd "${WORKDIR}"
git remote set-url origin "https://oauth2:${DOCS_BOT_TOKEN}@${host}/${ORG}/${REPO}.git"
git_identity
git config --global user.name "docs-bot" || true
git config --global user.email "docs-bot@plainskill.net" || true
MAIN_SHA="$(git rev-parse HEAD)"
echo "==> cloned ${ORG}/${REPO} ${MAIN_SHA}"

if [ -n "${DOCS_GITHUB_TOKEN:-}" ]; then
  git remote add github "https://x-access-token:${DOCS_GITHUB_TOKEN}@github.com/${ORG}/${REPO}.git" 2>/dev/null || true
  echo "==> added github remote (optional)"
fi
echo "==> skip dep inventory (docs-bot)"
true  # no inventory.py "${clone_dest}" --out "${INVENTORY}"
echo "==> inventory written ${INVENTORY}"

echo "==> open PR overlap (Forgejo)"
set +e
prs="$(fj_list_open_prs "${ORG}" "${REPO}")"
prc=$?
set -e
if [ "${prc}" -eq 0 ] && [ -n "${prs}" ]; then
  python3 -c '
import json, os, sys, urllib.request
raw = sys.stdin.read()
try:
    data = json.loads(raw or "[]")
except json.JSONDecodeError:
    data = []
base = os.environ.get("FORGEJO_URL", "https://gt.plainskill.net").rstrip("/")
token = os.environ.get("DOCS_BOT_TOKEN") or ""
paths = []
for pr in data if isinstance(data, list) else []:
    n = pr.get("number")
    if not n:
        continue
    url = f"{base}/api/v1/repos/{sys.argv[1]}/{sys.argv[2]}/pulls/{n}/files"
    req = urllib.request.Request(url, headers={"Authorization": f"token {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            files = json.loads(resp.read().decode("utf-8") or "[]")
    except Exception:
        continue
    for f in files if isinstance(files, list) else []:
        name = f.get("filename") or f.get("name") or ""
        if name:
            paths.append(name)
open(sys.argv[3], "a", encoding="utf-8").write("\n".join(paths) + ("\n" if paths else ""))
' "${ORG}" "${REPO}" "${SKIP_PATHS}" <<EOF
${prs}
EOF
fi
if command -v gh >/dev/null 2>&1 && [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "==> open PR overlap (GitHub, optional)"
  set +e
  gh pr list --repo "${ORG}/${REPO}" --state open --json files,headRefName >/tmp/lock-gh-prs.json 2>/tmp/lock-gh-prs.err
  set -e
  if [ -f /tmp/lock-gh-prs.json ]; then
    python3 -c 'import json,sys
try: data=json.load(open("/tmp/lock-gh-prs.json",encoding="utf-8"))
except Exception: data=[]
out=open(sys.argv[1],"a",encoding="utf-8")
for pr in data if isinstance(data,list) else []:
    for f in pr.get("files") or []:
        name=f.get("path") or f.get("filename") or ""
        if name: out.write(name+"\n")
' "${SKIP_PATHS}"
  fi
fi
echo "==> skip lockfile generation (docs-bot)"
export DSH_HOME="${HERE}/dsh-home"
export DSH_PERMISSION_MODE=danger-full-access
export PYTHONUNBUFFERED=1
PROMPT_FILE="${HERE}/prompt.md"
TASK="$(cat "${PROMPT_FILE}")

Wrapper task: You are docs-bot. Skip-path list is at ${SKIP_PATHS} (DATA).
FIRST: review the day's commits (git log / git show since yesterday). Then update docs those commits made false.
Delete stale markdown. Fix only if blank would be dangerous. Do not bump deps. Do not audit quality/security.
Write the summary to ${DOCS_RESULT}. Empty file = failed job. If nothing is false, write 'nothing false' plus the SHAs reviewed.
Do not merge. Do not post pull-request reviews. Do not stop containers.
Do not take atlas-bot or ai-proxy down."

echo "==> dsh start $(date -u +%H:%M:%SZ) job=${JOBID}"
: > "${DSH_LOG}"
if [ -f "${HERE}/log_dsh_events.mjs" ]; then
  node "${HERE}/log_dsh_events.mjs" "${DSH_HOME}" "${DSH_LOG}" &
  LOG_PID=$!
  echo "==> dsh event logger pid=${LOG_PID}"
fi
set +e
if command -v stdbuf >/dev/null 2>&1; then
  stdbuf -oL -eL dsh --profile headless "${TASK}" >>"${DSH_LOG}" 2>&1 &
else
  dsh --profile headless "${TASK}" >>"${DSH_LOG}" 2>&1 &
fi
DSH_PID=$!
echo "==> dsh pid=${DSH_PID}"
wait "${DSH_PID}"
dsh_rc=$?
set -e
DSH_PID=""
if [ -n "${LOG_PID:-}" ]; then
  kill "${LOG_PID}" 2>/dev/null || true
  wait "${LOG_PID}" 2>/dev/null || true
fi
echo "==> dsh exit ${dsh_rc}"

DSH_TRY=1
while ! result_written && [ "${DSH_TRY}" -lt 3 ]; do
  DSH_TRY=$((DSH_TRY + 1))
  echo "==> empty DOCS_RESULT; nudge ${DSH_TRY}/3" >&2
  set +e
  dsh --profile headless "${TASK}

You exited without writing a non-empty summary to ${DOCS_RESULT}. Write it now." >>"${DSH_LOG}" 2>&1
  dsh_rc=$?
  set -e
done
if [ "${dsh_rc}" -ne 0 ]; then
  echo "==> dsh failed rc=${dsh_rc}; not treating as success" >&2
  exit 2
fi
git add -A || true
if git diff --cached --quiet && git diff --quiet; then
  echo "==> worktree clean after dsh"
else
  git checkout -B "docs-bot/work-${JOBID}"
  git add -A
  git commit -m "docs: docs-bot worktree ${DAY}" || true
fi
WORK_SHA="$(git rev-parse HEAD)"
CHANGED="$(git diff --name-only "${MAIN_SHA}" "${WORK_SHA}" || true)"
echo "==> changed files:" 
echo "${CHANGED}"
echo "==> preparing Forgejo PR from worktree vs ${MAIN_SHA}"
HAS_CHANGES=0
if [ "${WORK_SHA}" != "${MAIN_SHA}" ]; then
  HAS_CHANGES=1
fi
if [ "${HAS_CHANGES}" -eq 0 ]; then
  echo "==> nothing to PR"
fi
if [ "${HAS_CHANGES}" -eq 1 ]; then
  BRANCH="docs-bot/docs-${DAY}"
  if git ls-remote --heads origin "${BRANCH}" 2>/dev/null | grep -q .; then
    BRANCH="docs-bot/docs-${DAY}-${JOBID}"
  fi
  git branch -M "${BRANCH}" || git checkout -B "${BRANCH}"
  echo "==> push ${BRANCH}"
  set +e
  git push -u origin "HEAD:refs/heads/${BRANCH}"
  push_rc=$?
  set -e
  if [ "${push_rc}" -ne 0 ]; then
    echo "==> push failed rc=${push_rc}" >&2
    echo "push failed" >> "${DOCS_RESULT}"
    exit 2
  fi
  TITLE="docs: follow today's commits"
  if git diff --name-only "${MAIN_SHA}" "${WORK_SHA}" | grep -qE 'package.json|go.mod|Cargo.toml|pyproject.toml'; then
    TITLE="docs: follow today's commits"
  fi
  BODY="$(cat "${DOCS_RESULT}")"
  echo "==> create PR ${TITLE}"
  PIN_PR="$(fj_create_pr "${ORG}" "${REPO}" "${BRANCH}" main "${TITLE}" "${BODY}")"
  echo "==> PR ${PIN_PR}"
  echo "" >> "${DOCS_RESULT}"
  echo "${PIN_PR}" >> "${DOCS_RESULT}"
fi
if [ -n "${DOCS_GITHUB_TOKEN:-}" ]; then
  git push github "HEAD:refs/heads/${BRANCH:-docs-bot/docs-${DAY}}" || true
fi

if ! result_written; then
  echo "==> empty DOCS_RESULT; failing" >&2
  exit 2
fi
echo "==> done DOCS_RESULT=$(wc -c < "${DOCS_RESULT}") bytes"
exit 0
