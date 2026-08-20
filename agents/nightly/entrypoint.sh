#!/usr/bin/env bash
# LibreServ Nightly Maintenance Agent — container entrypoint.
#
# 1. Fresh clone of origin/main into /work/repo (disposable).
# 2. Resolve LAST_RUN_SHA from /state/last_run_sha (persisted across runs).
# 3. Boot dsh in headless mode with the nightly prompt as the task, cwd = clone.
# 4. Capture the agent's final message to /state, record the new HEAD marker.
# 5. Exit with dsh's exit code (0 = task completed, 1 = error).

set -euo pipefail

: "${REPO_URL:?REPO_URL is required}"
: "${FORGEJO_TOKEN:?FORGEJO_TOKEN is required (Forgejo API token)}"
: "${AI_PROXY_API_KEY:?AI_PROXY_API_KEY is required (LLM provider key)}"

AGENT_HOME="${AGENT_HOME:-/opt/agent}"
PROMPT_FILE="${PROMPT_FILE:-${AGENT_HOME}/prompt.md}"
STATE_DIR="${STATE_DIR:-/state}"
CLONE_DIR="${CLONE_DIR:-/work/repo}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"

echo "==> nightly agent run ${RUN_ID}"
echo "==> repo: ${REPO_URL}"

if [[ "${REVIEW_MODE:-0}" == "1" ]]; then
  # Push-review mode: no clone. The host staged the diff+commits into /state
  # and (optionally) mounted its working tree read-only at /work/host-repo for
  # context. We just boot dsh with the review prompt against /state.
  echo "==> review mode: using staged diff in /state"
  cd /work
else
  # ---- clean slate ----
  rm -rf "${CLONE_DIR}"
  git clone --quiet "${REPO_URL}" "${CLONE_DIR}"
  cd "${CLONE_DIR}"

  # Configure push auth + identity so the agent can push its branch and open a PR.
  git remote set-url origin "https://oauth2:${FORGEJO_TOKEN}@${REPO_URL#https://}"
  git config user.name  "LibreServ Nightly"
  git config user.email "nightly@libreserv.local"
fi

# ---- LAST_RUN_SHA marker ----
# Prefer an explicit env value (launcher pass-through), else the persisted
# marker from the previous successful run.
if [[ -z "${LAST_RUN_SHA:-}" ]]; then
  LAST_RUN_SHA="$(cat "${STATE_DIR}/last_run_sha" 2>/dev/null || true)"
fi
export LAST_RUN_SHA
if [[ -n "${LAST_RUN_SHA}" ]]; then
  echo "==> last run marker: ${LAST_RUN_SHA}"
else
  echo "==> no prior marker; agent will use last-24h fallback"
fi

# ---- run the agent ----
export FORGEJO_TOKEN AI_PROXY_API_KEY DSH_HOME="${DSH_HOME:-/opt/dsh}"

echo "==> booting dsh headless"
set +e
dsh --profile headless "$(cat "${PROMPT_FILE}")" 2>&1 | tee "${STATE_DIR}/run-${RUN_ID}.log"
status=${PIPESTATUS[0]}
set -e

echo "==> dsh exit: ${status}"

# ---- record marker on success (nightly mode only) ----
if [[ ${status} -eq 0 && "${REVIEW_MODE:-0}" != "1" ]]; then
  new_head="$(git ls-remote --quiet origin main | awk '{print $1}')"
  if [[ -n "${new_head}" ]]; then
    echo "${new_head}" > "${STATE_DIR}/last_run_sha"
    echo "==> marker updated: ${new_head}"
  fi
fi

exit ${status}
