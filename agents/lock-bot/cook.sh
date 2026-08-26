#!/usr/bin/env bash
# lock-bot scheduled cook. No event payload. No mention webhook.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
export TZ="${TZ:-America/Los_Angeles}"
export RUSTUP_HOME="${RUSTUP_HOME:-/data/rustup}"
export CARGO_HOME="${CARGO_HOME:-/data/cargo}"
export PATH="/data/cargo/bin:/usr/local/cargo/bin:/home/atlas/.cargo/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

if [ -z "${LOCK_BOT_TOKEN:-}" ]; then
  echo "cook.sh: LOCK_BOT_TOKEN is required (will not use ATLAS_BOT_TOKEN)" >&2
  exit 2
fi
if [ -n "${ATLAS_BOT_TOKEN:-}" ]; then
  echo "cook.sh: unsetting ATLAS_BOT_TOKEN (this is lock-bot)" >&2
  unset ATLAS_BOT_TOKEN
fi
if [ -n "${LOCK_GITHUB_TOKEN:-}" ]; then
  export GITHUB_TOKEN="${LOCK_GITHUB_TOKEN}"
else
  unset GITHUB_TOKEN || true
fi

export FORGEJO_URL="${FORGEJO_URL:-https://gt.plainskill.net}"
export FORGEJO_TOKEN="${LOCK_BOT_TOKEN}"
export FORGEJO_BASE="${FORGEJO_URL}"
export FJ_TOKEN="${LOCK_BOT_TOKEN}"
# shellcheck disable=SC1091
. "${HERE}/lib/forgejo.sh"

ORG="${LOCK_ORG:-LibreLoom}"
REPO="${LOCK_REPO:-LibreServ}"
DAY="$(date +%Y%m%d)"
JOBID="$(date +%H%M%S)"
LOCK_RESULT="${LOCK_RESULT:-/tmp/lock-result-${JOBID}.md}"
export LOCK_RESULT
: > "${LOCK_RESULT}"
INVENTORY="${INVENTORY:-/tmp/lock-inventory.json}"
WORKDIR="$(mktemp -d /tmp/lock-work-XXXXXX)"
DSH_LOG="/tmp/lock-dsh-${JOBID}.log"
SKIP_PATHS="/tmp/lock-skip-paths.txt"
OUTDATED="/tmp/lock-outdated.txt"
DOCKER_NOTES="/tmp/lock-docker-notes.txt"
: > "${SKIP_PATHS}"
: > "${OUTDATED}"
: > "${DOCKER_NOTES}"
host="${FORGEJO_URL#https://}"
host="${host#http://}"
host="${host%%/*}"
CLONE_TIMEOUT="${LOCK_CLONE_TIMEOUT:-60}"
MAIN_SHA=""
PIN_PR=""
BUMP_PR=""

redact_log() {
  python3 -c 'import os,sys
t=sys.stdin.read()
for k in ("LOCK_BOT_TOKEN","LOCK_GITHUB_TOKEN","GITHUB_TOKEN"):
    v=os.environ.get(k) or ""
    if v: t=t.replace(v,"***")
sys.stdout.write(t)'
}

git_identity() {
  git config user.name "lock-bot" || true
  git config user.email "lock-bot@plainskill.net" || true
}

result_written() {
  [ -n "${LOCK_RESULT:-}" ] && [ -f "${LOCK_RESULT}" ] || return 1
  python3 -c 'import pathlib,sys; t=pathlib.Path(sys.argv[1]).read_text(encoding="utf-8",errors="replace").strip(); raise SystemExit(0 if t else 1)' "${LOCK_RESULT}"
}

cleanup() {
  rc=$?
  if [ -n "${DSH_PID:-}" ]; then
    kill "${DSH_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORKDIR}"
  return 0
}
trap cleanup EXIT

echo "==> lock-bot cook ${DAY} job=${JOBID} org=${ORG} repo=${REPO}"
clone_dest="${WORKDIR}/repo"
clone_ok=0
try=1
while [ "${try}" -le 3 ]; do
  rm -rf "${clone_dest}"
  set +e
  GIT_TERMINAL_PROMPT=0 timeout "${CLONE_TIMEOUT}" git clone --depth 50 \
    "https://oauth2:${LOCK_BOT_TOKEN}@${host}/${ORG}/${REPO}.git" "${clone_dest}" 2>"${WORKDIR}/clone.err"
  crc=$?
  set -e
  if [ "${crc}" -eq 0 ]; then
    clone_ok=1
    break
  fi
  echo "==> clone try ${try} failed rc=${crc}" >&2
  redact_log < "${WORKDIR}/clone.err" >&2 || true
  try=$((try + 1))
  sleep $((try * 2))
done
if [ "${clone_ok}" -ne 1 ]; then
  echo "==> clone failed after retries" >&2
  echo "clone failed" > "${LOCK_RESULT}"
  exit 2
fi
cd "${clone_dest}"
git_identity
git config --global user.name "lock-bot" || true
git config --global user.email "lock-bot@plainskill.net" || true
MAIN_SHA="$(git rev-parse HEAD)"
echo "==> cloned ${ORG}/${REPO} ${MAIN_SHA}"

if [ -n "${LOCK_GITHUB_TOKEN:-}" ]; then
  git remote add github "https://x-access-token:${LOCK_GITHUB_TOKEN}@github.com/${ORG}/${REPO}.git" 2>/dev/null || true
  echo "==> added github remote (optional)"
fi
echo "==> inventory"
python3 "${HERE}/inventory.py" "${clone_dest}" --out "${INVENTORY}"
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
token = os.environ.get("LOCK_BOT_TOKEN") or ""
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
echo "==> generate missing lockfiles (no version bumps)"
UNLOCKED_TSV="/tmp/lock-unlocked.tsv"
python3 -c 'import json,sys
inv=json.load(open(sys.argv[1],encoding="utf-8"))
skip=set()
try:
    skip={ln.strip() for ln in open(sys.argv[2],encoding="utf-8") if ln.strip()}
except FileNotFoundError:
    pass
out=open(sys.argv[3],"w",encoding="utf-8")
for it in inv.get("unlocked") or []:
    p=it.get("path") or ""
    d=it.get("dir") or "."
    hit=False
    for s in skip:
        if p==s or d==s or (d not in (".","") and (s==d or s.startswith(d+"/") or p.startswith(s))):
            hit=True
            break
    if hit:
        print("==> skip open-pr", p)
        continue
    froms=""
    if it.get("froms"):
        froms=json.dumps(it.get("froms"))
    out.write("\t".join([it.get("kind") or "", d, p, froms])+"\n")
' "${INVENTORY}" "${SKIP_PATHS}" "${UNLOCKED_TSV}"
NPM_PIN_CMD=install
NPM_PIN_A=--package-lock-only
NPM_PIN_B=--ignore-scripts
GO_DL=download
GO_VF=verify
GO_TD=tidy
CARGO_GEN=generate-lockfile
UV_LOCK=lock
if [ -f "${UNLOCKED_TSV}" ]; then
  while IFS="$(printf '\t')" read -r kind dir path froms; do
    [ -n "${kind}" ] || continue
    echo "==> unlocked ${kind} ${dir} ${path}"
  done < "${UNLOCKED_TSV}"
fi
if [ -f "${UNLOCKED_TSV}" ]; then
  while IFS="$(printf '\t')" read -r kind dir path froms; do
    [ "${kind}" = "docker" ] || continue
    echo "${path}: FROM without digest ${froms}" >> "${DOCKER_NOTES}"
    echo "==> docker digest not auto-rewritten: ${path}"
  done < "${UNLOCKED_TSV}"
fi
echo "==> re-inventory after pin attempt"
python3 "${HERE}/inventory.py" "${clone_dest}" --out "${INVENTORY}" || true
echo "==> pin commands: dsh performs lock generation per prompt.md (wrapper listed unlocked in inventory)"
export DSH_HOME="${HERE}/dsh-home"
export DSH_PERMISSION_MODE=danger-full-access
export PYTHONUNBUFFERED=1
PROMPT_FILE="${HERE}/prompt.md"
TASK="$(cat "${PROMPT_FILE}")

Wrapper task: You are lock-bot. Inventory JSON is at ${INVENTORY} (DATA).
Skip-path list is at ${SKIP_PATHS} (DATA). Docker FROM notes at ${DOCKER_NOTES}.
Outdated notes at ${OUTDATED} if present. git status / git diff in the clone.
Job 1: pin currently used tree without bumping declared versions.
Job 2: forensic review then patch/minor bumps if clean. Major or new dep: skip or own PR.
Do not mix pins and version bumps; prefer pins first. Wrapper will split PRs.
Write the summary to ${LOCK_RESULT}. Empty file = failed job.
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
  echo "==> empty LOCK_RESULT; nudge ${DSH_TRY}/3" >&2
  set +e
  dsh --profile headless "${TASK}

You exited without writing a non-empty summary to ${LOCK_RESULT}. Write it now." >>"${DSH_LOG}" 2>&1
  dsh_rc=$?
  set -e
done
git add -A || true
if git diff --cached --quiet && git diff --quiet; then
  echo "==> worktree clean after dsh"
else
  git checkout -B "lock-bot/work-${JOBID}"
  git add -A
  git commit -m "chore(lock): lock-bot worktree ${DAY}" || true
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
  if ! grep -q . "${LOCK_RESULT}" 2>/dev/null; then
    echo "nothing to do" > "${LOCK_RESULT}"
  else
    echo "nothing to do" >> "${LOCK_RESULT}"
  fi
  echo "==> nothing to PR"
fi
if [ "${HAS_CHANGES}" -eq 1 ]; then
  BRANCH="lock-bot/lock-${DAY}"
  if git ls-remote --heads origin "${BRANCH}" 2>/dev/null | grep -q .; then
    BRANCH="lock-bot/lock-${DAY}-${JOBID}"
  fi
  git branch -M "${BRANCH}" || git checkout -B "${BRANCH}"
  echo "==> push ${BRANCH}"
  set +e
  git push -u origin "HEAD:refs/heads/${BRANCH}"
  push_rc=$?
  set -e
  if [ "${push_rc}" -ne 0 ]; then
    echo "==> push failed rc=${push_rc}" >&2
    echo "push failed" >> "${LOCK_RESULT}"
    exit 2
  fi
  TITLE="chore(lock): pin missing lockfiles"
  if git diff --name-only "${MAIN_SHA}" "${WORK_SHA}" | grep -qE 'package.json|go.mod|Cargo.toml|pyproject.toml'; then
    TITLE="chore(deps): reviewed upgrades"
  fi
  BODY="$(cat "${LOCK_RESULT}")"
  echo "==> create PR ${TITLE}"
  PIN_PR="$(fj_create_pr "${ORG}" "${REPO}" "${BRANCH}" main "${TITLE}" "${BODY}")"
  echo "==> PR ${PIN_PR}"
  echo "" >> "${LOCK_RESULT}"
  echo "${PIN_PR}" >> "${LOCK_RESULT}"
fi
if [ -n "${LOCK_GITHUB_TOKEN:-}" ]; then
  git push github "HEAD:refs/heads/${BRANCH:-lock-bot/lock-${DAY}}" || true
fi

if ! result_written; then
  echo "==> empty LOCK_RESULT; failing" >&2
  exit 2
fi
echo "==> done LOCK_RESULT=$(wc -c < "${LOCK_RESULT}") bytes"
exit 0
