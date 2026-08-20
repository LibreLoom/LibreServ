# LibreServ Nightly Maintenance Agent — Runtime

The container the nightly agent runs in, plus the host-side launcher.
Built on **dsh** (`@deepseek-ai/dsh` headless profile), runs in **Docker**
(or Podman) with the host's container-runtime socket mounted so `./ci` can
spawn test containers.

## Handoff summary (for the deploy agent)

| Piece | Location |
|---|---|
| Prompt (agent instructions) | `agents/nightly-maintenance-prompt.md` |
| Runtime image Dockerfile | `agents/nightly/Dockerfile` |
| Container entrypoint | `agents/nightly/entrypoint.sh` |
| Launcher CLI (`--nightly` / `--push-review`) | `agents/nightly/nightly.sh` |
| Push-review prompt | `agents/nightly/review-prompt.md` |
| (legacy) host launcher | `agents/nightly/run-nightly.sh` |
| dsh settings + headless profile | `agents/nightly/dsh-home/` |

## CLI (`nightly.sh`)

```bash
# Nightly maintenance review (deps + docs + test fixes) → one PR, or none.
FORGEJO_TOKEN=... AI_PROXY_API_KEY=... ./nightly.sh --nightly

# Same, but auto-push the branch and open the PR via the Forgejo API.
FORGEJO_TOKEN=... AI_PROXY_API_KEY=... ./nightly.sh --nightly --auto-pr

# Review the current local diff (base..HEAD, working tree included) before pushing.
FORGEJO_TOKEN=... ./nightly.sh --push-review

# Review, then push + open PR only if the verdict is APPROVED.
FORGEJO_TOKEN=... ./nightly.sh --push-review --auto-pr

./nightly.sh --help
```

`--push-review` stages the diff into the state volume, mounts your working tree
read-only into the container, and runs the review agent (security, supply chain,
correctness, conventions, docs drift). The agent prints findings and a final
`VERDICT: APPROVED` / `VERDICT: CHANGES_REQUESTED`. With `--auto-pr`, an
`APPROVED` verdict pushes `HEAD` and opens a PR (idempotent — skips if a PR for
that head is already open); `CHANGES_REQUESTED` blocks the push with exit 3.

## Build

```bash
# Build context MUST be agents/ (the Dockerfile COPYs ../nightly-maintenance-prompt.md
# and nightly/dsh-home relative to it).
cd agents
docker build -f nightly/Dockerfile -t libreserv-nightly .
# or just let the launcher build it (it uses the correct context):
cd agents/nightly && ./run-nightly.sh --build
```

The prompt file (`nightly-maintenance-prompt.md`) is baked into the image at
`/opt/agent/prompt.md`.

## Run (nightly cron / deploy agent)

```bash
cd agents/nightly
FORGEJO_TOKEN=<forgejo-api-token> \
AI_PROXY_API_KEY=<llm-provider-key> \
./run-nightly.sh
```

The launcher:
1. builds the image if missing (`--build` forces a rebuild),
2. creates the persistent volume `libreserv-nightly-state`,
3. mounts the host's container-runtime socket (`/var/run/docker.sock`, or the
   rootless podman socket) into the container so `./ci` can spawn test
   containers,
4. runs the container; the entrypoint clones the repo fresh, runs the dsh
   headless agent, logs to the state volume, and exits with the agent's code.

Exit code: `0` = task completed (agent may or may not have opened a PR),
`1` = agent errored. Check `/state/run-*.log` (volume
`libreserv-nightly-state`) for the agent's final message and per-codebase CI
results.

## Required env vars

| Variable | Purpose |
|---|---|
| `FORGEJO_TOKEN` | Forgejo API token, `write:repository` + PR creation (rotate independently of personal tokens). |
| `AI_PROXY_API_KEY` | LLM provider key (read by dsh via `apiKeyEnv`; never stored in the image). |

Optional: `LAST_RUN_SHA` (else read from the state volume), `REPO_URL`,
`PROMPT_FILE` (bind-mount override), `NIGHTLY_IMAGE`, `STATE_VOLUME`,
`CONTAINER_RUNTIME`.

## What the image contains

- **dsh CLI** (`@deepseek-ai/dsh@0.1.0-rc.6`) + a headless profile
  (`dsh-home/profiles/headless`) with the Exa MCP web-search tool added, so the
  agent can search the web during dep review.
- **Go 1.26.5** (backend, connect, ci-source, companion).
- **Rust 1.96 + clippy + rustfmt** (luna workspace).
- **Android SDK** (cmdline-tools, platform 34, build-tools 34) + OpenJDK 17
  (luna/mobile gradle tests).
- **Docker CLI + Podman** (client side; the `./ci` runner discovers the mounted
  host socket: `DOCKER_HOST` → podman rootless → podman rootful →
  `/var/run/docker.sock`).
- git, curl, jq, gcc/libc-dev (CGO), make, bash.

## Notes & gotchas

- **SELinux host**: mounting the podman socket into a container is blocked for
  `podman-build`; the repo's CI runner already runs that test with
  `Container: "host"`. If the agent container can't reach a socket, `./ci`
  fails loudly and the agent aborts without a PR (per the prompt) — surface
  that, don't treat it as a no-op night.
- **First run is slow**: Android SDK + gradle testDebugUnitTest + full `./ci`
  profile (fuzz, race, gosec, staticcheck, podman-build) can take 15–60+ min.
  The image build itself downloads Go/Rust/Android toolchains (~1–2 GB).
- **Marker**: the entrypoint writes the new `origin/main` HEAD to
  `/state/last_run_sha` on success, so the next run's docs-review range is
  exact rather than a 24h clock guess.
- **Prompt updates**: rebuild the image (or pass `PROMPT_FILE` to bind-mount a
  newer prompt without a rebuild).
- **dsh version pin**: `@deepseek-ai/dsh@0.1.0-rc.6` matches the host install.
  Bump deliberately and re-verify the headless profile boots (`dsh --profile
  headless "say ok"`).
- **Cron example** (host):
  ```bash
  15 2 * * * cd /path/to/LibreServ/agents/nightly && \
    FORGEJO_TOKEN=... AI_PROXY_API_KEY=... ./run-nightly.sh >> /var/log/libreserv-nightly.log 2>&1
  ```
