#!/usr/bin/env bash
# LibreServ Nightly Maintenance Agent — host-side launcher.
#
# Builds the runtime image if needed, then runs the container with:
#   - LLM + Forgejo credentials from the environment
#   - the host's container-runtime socket mounted (Docker or Podman; `./ci`
#     discovers it via DOCKER_HOST -> podman rootless -> podman rootful ->
#     /var/run/docker.sock)
#   - a persistent named volume for /state (LAST_RUN_SHA marker + run logs)
#
# Usage:
#   FORGEJO_TOKEN=... AI_PROXY_API_KEY=... ./run-nightly.sh
#   FORGEJO_TOKEN=... AI_PROXY_API_KEY=... ./run-nightly.sh --build
#   FORGEJO_TOKEN=... AI_PROXY_API_KEY=... LAST_RUN_SHA=<sha> ./run-nightly.sh
#
# Optional env:
#   NIGHTLY_IMAGE    image name (default libreserv-nightly:latest)
#   STATE_VOLUME     named volume (default libreserv-nightly-state)
#   REPO_URL         overrides the baked-in repo URL
#   PROMPT_FILE      overrides the baked-in prompt (bind-mounted read-only)
#   CONTAINER_RUNTIME   docker | podman (default: docker if present, else podman)

set -euo pipefail
cd "$(dirname "$0")"

: "${FORGEJO_TOKEN:?FORGEJO_TOKEN is required}"
: "${AI_PROXY_API_KEY:?AI_PROXY_API_KEY is required}"

IMAGE="${NIGHTLY_IMAGE:-libreserv-nightly:latest}"
STATE_VOLUME="${STATE_VOLUME:-libreserv-nightly-state}"
REPO_URL="${REPO_URL:-https://gt.plainskill.net/LibreLoom/LibreServ.git}"
PROMPT_FILE="${PROMPT_FILE:-}"
BUILD_FLAG="${1:-}"

if command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
else
  echo "error: neither docker nor podman found on host" >&2
  exit 1
fi
echo "==> container runtime: ${RUNTIME}"

# Build the image if missing or --build was passed.
# Build context is the repo's agents/ dir: the Dockerfile lives in
# nightly/Dockerfile and COPYs ../nightly-maintenance-prompt.md + nightly/dsh-home.
AGENTS_DIR="$(cd .. && pwd)"
if [[ "${BUILD_FLAG}" == "--build" ]] || ! "${RUNTIME}" image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "==> building ${IMAGE}"
  "${RUNTIME}" build -t "${IMAGE}" -f Dockerfile "${AGENTS_DIR}"
fi

"${RUNTIME}" volume create "${STATE_VOLUME}" >/dev/null 2>&1 || true

# Socket to mount. Docker uses /var/run/docker.sock; podman rootless uses the
# XDG runtime dir; try them in order.
if [[ -S "/var/run/docker.sock" ]]; then
  SOCKET=/var/run/docker.sock
  SOCKET_TARGET=/var/run/docker.sock
elif [[ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock" ]]; then
  SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"
  SOCKET_TARGET=/run/podman/podman.sock
else
  echo "warning: no container-runtime socket found on host; ./ci inside the agent will fail to spawn test containers" >&2
  SOCKET=
  SOCKET_TARGET=
fi

ARGS=(
  --rm
  -e "FORGEJO_TOKEN=${FORGEJO_TOKEN}"
  -e "AI_PROXY_API_KEY=${AI_PROXY_API_KEY}"
  -e "REPO_URL=${REPO_URL}"
  -e "LAST_RUN_SHA=${LAST_RUN_SHA:-}"
  -v "${STATE_VOLUME}:/state"
)
if [[ -n "${SOCKET}" ]]; then
  ARGS+=( -v "${SOCKET}:${SOCKET_TARGET}" )
fi
if [[ -n "${PROMPT_FILE}" ]]; then
  ARGS+=( -v "$(realpath "${PROMPT_FILE}"):/opt/agent/prompt.md:ro" )
fi

echo "==> starting nightly agent"
exec "${RUNTIME}" run "${ARGS[@]}" "${IMAGE}"
