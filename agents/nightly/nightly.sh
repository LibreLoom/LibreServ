#!/usr/bin/env bash
# LibreServ Nightly Maintenance Agent + Push Review — launcher CLI.
#
# Modes:
#   --nightly                 Run the nightly maintenance review (deps + docs +
#                             test fixes) in the runtime container. The agent
#                             prepares one PR per the nightly prompt.
#   --push-review             Review the current local diff (base..HEAD) before
#                             pushing; prints the verdict and blocks on
#                             CHANGES_REQUESTED.
#
# Modifiers:
#   --auto-pr                 After a successful run, push the branch and open a
#                             PR via the Forgejo API (idempotent: skips if an
#                             open PR for that head already exists).
#   --base <ref>              Base ref for the review diff (default origin/main).
#
# Usage:
#   FORGEJO_TOKEN=... AI_PROXY_API_KEY=... ./nightly.sh --nightly
#   FORGEJO_TOKEN=... AI_PROXY_API_KEY=... ./nightly.sh --nightly --auto-pr
#   FORGEJO_TOKEN=... ./nightly.sh --push-review            # review only
#   FORGEJO_TOKEN=... ./nightly.sh --push-review --auto-pr  # review, then push+PR if approved
#   ./nightly.sh --help
#
# Optional env: NIGHTLY_IMAGE, STATE_VOLUME, REPO_URL, PROMPT_FILE,
#               CONTAINER_RUNTIME (docker|podman), DSH_FORGEJO_BASE,
#               DSH_REPO_PATH (owner/repo for the Forgejo API).

set -euo pipefail
cd "$(dirname "$0")"

MODE=""
AUTO_PR=0
BASE_REF="origin/main"
HELP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nightly)     MODE="nightly"; shift ;;
    --push-review) MODE="push-review"; shift ;;
    --auto-pr)     AUTO_PR=1; shift ;;
    --base)        BASE_REF="${2:?--base needs a ref}"; shift 2 ;;
    --help|-h)     HELP=1; shift ;;
    *)             echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ${HELP} -eq 1 ]]; then
  # Print only the header comment block (up to the first code line).
  awk '/^#!\/usr\/bin\/env bash/{print; next} /^#/{sub(/^# ?/, ""); print; next} {exit}' "$0"
  exit 0
fi

# Default mode is nightly.
if [[ -z "${MODE}" ]]; then MODE="nightly"; fi

if [[ "${MODE}" == "nightly" ]]; then
  : "${FORGEJO_TOKEN:?FORGEJO_TOKEN is required}"
  : "${AI_PROXY_API_KEY:?AI_PROXY_API_KEY is required}"
fi
if [[ "${MODE}" == "push-review" ]]; then
  : "${FORGEJO_TOKEN:?FORGEJO_TOKEN is required}"
  : "${AI_PROXY_API_KEY:?AI_PROXY_API_KEY is required}"
fi

IMAGE="${NIGHTLY_IMAGE:-libreserv-nightly:latest}"
STATE_VOLUME="${STATE_VOLUME:-libreserv-nightly-state}"
REPO_URL="${REPO_URL:-https://gt.plainskill.net/LibreLoom/LibreServ.git}"

# Parse the Forgejo API base + repo path from REPO_URL.
# REPO_URL=https://gt.plainskill.net/LibreLoom/LibreServ.git
FORGEJO_BASE="${DSH_FORGEJO_BASE:-$(printf '%s' "${REPO_URL}" | sed -E 's#(https?://[^/]+)/.*#\1#')}"
REPO_PATH="${DSH_REPO_PATH:-$(printf '%s' "${REPO_URL}" | sed -E 's#https?://[^/]+/##; s#\.git$##')}"

if command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
else
  echo "error: neither docker nor podman found on host" >&2
  exit 1
fi
echo "==> runtime: ${RUNTIME} | mode: ${MODE} | auto-pr: $([ ${AUTO_PR} -eq 1 ] && echo on || echo off)"

# ---- build image if missing ----
AGENTS_DIR="$(pwd)"   # we cd'd to dirname $0 == agents/nightly; context is agents/
if ! "${RUNTIME}" image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "==> building ${IMAGE}"
  "${RUNTIME}" build -t "${IMAGE}" -f Dockerfile "$(cd .. && pwd)"
fi
"${RUNTIME}" volume create "${STATE_VOLUME}" >/dev/null 2>&1 || true

# ---- socket to mount ----
if [[ -S "/var/run/docker.sock" ]]; then
  SOCKET=/var/run/docker.sock; SOCKET_TARGET=/var/run/docker.sock
elif [[ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock" ]]; then
  SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"
  SOCKET_TARGET=/run/podman/podman.sock
else
  echo "warning: no container-runtime socket found on host" >&2
  SOCKET=; SOCKET_TARGET=
fi

# ---- push-review: stage the diff + commit log into the state volume ----
if [[ "${MODE}" == "push-review" ]]; then
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "error: --push-review must run inside a git repo" >&2; exit 2; }
  echo "==> generating diff ${BASE_REF}..HEAD (working tree included)"
  git fetch origin >/dev/null 2>&1 || true
  # Review EVERYTHING not yet on the base: committed commits plus any working
  # tree / staged changes since the base.
  git diff "${BASE_REF}...HEAD" > "${TMPDIR:-/tmp}/libreserv-diff.patch" || true
  git diff "${BASE_REF}" >> "${TMPDIR:-/tmp}/libreserv-diff.patch" || true
  git log --oneline "${BASE_REF}..HEAD" > "${TMPDIR:-/tmp}/libreserv-commits.txt" 2>/dev/null || true
  if [[ ! -s "${TMPDIR:-/tmp}/libreserv-diff.patch" ]]; then
    echo "==> no diff between ${BASE_REF} and HEAD — nothing to review"
    exit 0
  fi
  echo "==> staging diff (${BASE_REF}..HEAD) for review"
  # Stage via stdin — file bind-mounts break on SELinux/rootless hosts.
  cat "${TMPDIR:-/tmp}/libreserv-diff.patch" | \
    "${RUNTIME}" run --rm -i -v "${STATE_VOLUME}:/state" busybox sh -c 'cat > /state/diff.patch'
  cat "${TMPDIR:-/tmp}/libreserv-commits.txt" | \
    "${RUNTIME}" run --rm -i -v "${STATE_VOLUME}:/state" busybox sh -c 'cat > /state/commits.txt'
  PROMPT_FILE_OVERRIDE="${PROMPT_FILE:-}"
fi

# ---- compose container args ----
ARGS=(
  --rm
  -e "FORGEJO_TOKEN=${FORGEJO_TOKEN}"
  -e "AI_PROXY_API_KEY=${AI_PROXY_API_KEY}"
  -e "REPO_URL=${REPO_URL}"
  -e "AUTO_PR=${AUTO_PR}"
  -e "BASE_REF=${BASE_REF}"
  -e "REVIEW_MODE=${REVIEW_MODE:-0}"
  -v "${STATE_VOLUME}:/state"
)
if [[ -n "${SOCKET}" ]]; then
  ARGS+=( -v "${SOCKET}:${SOCKET_TARGET}" )
fi
if [[ "${MODE}" == "push-review" ]]; then
  # Mount the host working tree read-only so the agent can read context for the
  # diff it's reviewing (it must NOT modify it). The review prompt is reached
  # through this same read-only mount, so no separate file bind-mount is needed.
  HOST_REPO="$(git rev-parse --show-toplevel)"
  ARGS+=( -v "${HOST_REPO}:/work/host-repo:ro" )
  ARGS+=( -e "PROMPT_FILE=/work/host-repo/agents/nightly/review-prompt.md" )
  if [[ -n "${PROMPT_FILE:-}" ]]; then
    # If the user passed an explicit PROMPT_FILE, still avoid file bind-mounts:
    # require it to be inside HOST_REPO (path is then reachable via the mount).
    PROMPT_FILE_ABS="$(realpath "${PROMPT_FILE}")"
    case "${PROMPT_FILE_ABS}" in
      "${HOST_REPO}"/*)
        REL="${PROMPT_FILE_ABS#"${HOST_REPO}"/}"
        ARGS+=( -e "PROMPT_FILE=/work/host-repo/${REL}" ) ;;
      *)
        echo "error: PROMPT_FILE must be inside the git repo (${HOST_REPO}) in push-review mode" >&2
        exit 2 ;;
    esac
  fi
else
  if [[ -n "${PROMPT_FILE_OVERRIDE:-}" ]]; then
    ARGS+=( -v "$(realpath "${PROMPT_FILE_OVERRIDE}"):/opt/agent/prompt.md:ro" )
    ARGS+=( -e "PROMPT_FILE=/opt/agent/prompt.md" )
  fi
fi

echo "==> starting ${MODE} run"
status=1
for attempt in 1 2 3; do
  "${RUNTIME}" run "${ARGS[@]}" "${IMAGE}"
  status=$?
  if [[ ${status} -eq 0 ]]; then break; fi
  if [[ ${attempt} -lt 3 ]]; then
    echo "==> run failed (exit ${status}), retrying (${attempt}/2) after 30s..."
    sleep 30
  fi
done

# ---- push-review post-step: auto-push + PR if approved ----
if [[ "${MODE}" == "push-review" && ${AUTO_PR} -eq 1 && ${status} -eq 0 ]]; then
  verdict="$("${RUNTIME}" run --rm -v "${STATE_VOLUME}:/state" busybox sh -c \
    "grep -h 'VERDICT:' /state/run-*.log 2>/dev/null | tail -1")"
  verdict="${verdict:-CHANGES_REQUESTED}"
  echo "==> review verdict: ${verdict}"
  if [[ "${verdict}" == *"APPROVED"* ]]; then
    echo "==> pushing HEAD and opening PR"
    push_url="https://oauth2:${FORGEJO_TOKEN}@$(printf '%s' "${REPO_URL}" | sed 's#https\?://##')"
    head_branch="$(git rev-parse --abbrev-ref HEAD)"
    if ! git push "${push_url}" "HEAD:${head_branch}" 2>/dev/null; then
      git push -u origin "HEAD:${head_branch}"
    fi
    # open PR if none exists for this head
    existing="$(curl -fsS -H "Authorization: token ${FORGEJO_TOKEN}" \
      "${FORGEJO_BASE}/api/v1/repos/${REPO_PATH}/pulls?state=open&head=${head_branch}" \
      2>/dev/null | jq -r 'if type=="array" and length>0 then .[0].number else empty end' 2>/dev/null || true)"
    if [[ -z "${existing}" ]]; then
      curl -fsS -X POST -H "Authorization: token ${FORGEJO_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg head "${head_branch}" --arg base "${BASE_REF#origin/}" \
              --arg title "push review approved: ${head_branch}" \
              --arg body "Reviewed by the LibreServ push-review agent. Verdict: APPROVED." \
              '{head:$head, base:$base, title:$title, body:$body}')" \
        "${FORGEJO_BASE}/api/v1/repos/${REPO_PATH}/pulls" >/dev/null \
      && echo "==> PR opened" || echo "==> PR open failed (see above)"
    else
      echo "==> PR #${existing} already open for ${head_branch}"
    fi
  else
    echo "==> push BLOCKED: review requested changes"
    exit 3
  fi
fi

exit ${status}
