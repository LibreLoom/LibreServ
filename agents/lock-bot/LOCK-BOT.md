# lock-bot

Scheduled supply-chain locker for LibreServ. **Not atlas-bot.** Not a mention bot.
No pull-request reviews. No webhook. Not the deleted agents/nightly harness.

Live path: `/opt/lock-bot`. Container name: `lock-bot`.
Schedule: once per calendar day at 03:00 America/Los_Angeles (after the 2am Grok Bot audit).
Weekends included; supply-chain does not wait.

## What it does

1. Makes every LibreServ dependency hash-locked (lockfiles, go.sum, Cargo.lock, image digests).
2. Forensically reviews the supply chain before allowing any hash change.
3. Keeps deps up to date: patch/minor after a clean review; majors flagged, never silent.

## Secrets

Env file on the host: `/stack/compose/.secrets/lock-bot.env`

Required:
- `LOCK_BOT_TOKEN` — Forgejo token for the lock-bot user. Never `ATLAS_BOT_TOKEN`.

Optional:
- `LOCK_GITHUB_TOKEN` — if set, the wrapper exports it as `GITHUB_TOKEN` and may add a GitHub remote.
- `LOCK_WEBHOOK` — not needed. This agent is scheduled-only. No mention intake.

Do not commit the env file. Do not put tokens in the repo.

## Forgejo user

Create user `lock-bot` on the Bots team with WRITE, same pattern as atlas-bot.
Org: LibreLoom. Repo: LibreServ. Identity: lock-bot / lock-bot@plainskill.net.

## How to kick

Default is the 03:00 PT loop (`loop.sh`). To run once now:

- `LOCK_RUN_NOW=1` on container start, then it enters the daily loop
- or exec into the container and run `/opt/lock-bot/cook.sh`

If cook.sh fails, the loop logs and continues. It does not crash the container.

## Image and compose

Share the atlas-bot image (it already has dsh, fj, node, go, rust).
Look up the live image with: inspect atlas-bot Config.Image.
Set `ATLAS_IMAGE` to that value. Command is `loop.sh`.

Placeholder compose: `compose.yml` in this directory.
Volumes: `/opt/lock-bot` bind, plus a `/data` volume for cargo.
env_file: `.secrets/lock-bot.env`. restart unless-stopped.
Do not publish 8787. Optional 8788 later — omit for now.
Do not include the atlas-bot service in this compose file.

## Hard no

Never privileged. Never mount the host container socket.
Never mount `/stack` except the secrets env_file.
Never take atlas-bot or ai-proxy down. Do not merge PRs. Do not start this container
from the agent box; deploy is a host operator job.
