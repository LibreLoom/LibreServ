# docs-bot

Scheduled docs steward for LibreServ. **Not atlas-bot. Not lock-bot.** Not a mention bot.
No pull-request reviews. No webhook. Not the deleted agents/nightly harness or docs-updater.

Live path: `/opt/docs-bot`. Container name: `docs-bot`.
Schedule: once per calendar day at 04:00 America/Los_Angeles (after lock-bot at 03:00).
Weekends included; false docs should not sit all weekend.

This exists because Grok Bot access goes away; docs must not live only in that chat.

## What it does

Keep documentation true, or gone. Delete stale or false markdown. Rewrite only when leaving a blank would be dangerous (ports, auth, install). Do not grow AGENTS.md. Do not bump deps.

## Secrets

Env file on the host: `/stack/compose/.secrets/docs-bot.env`

Required:
- `DOCS_BOT_TOKEN` — Forgejo token for the docs-bot user. Never `ATLAS_BOT_TOKEN` or `LOCK_BOT_TOKEN`.

Optional:
- `DOCS_GITHUB_TOKEN` — if set, the wrapper may also push a GitHub remote.

Do not commit the env file.

## Forgejo user

Create user `docs-bot` (email `docs-bot@plainskill.net`) on the **Bots** team with WRITE, same pattern as atlas-bot and lock-bot.

## How to kick

Default is the 04:00 PT loop (`loop.sh`). To run once now:

- `DOCS_RUN_NOW=1` on container start, then it enters the daily loop
- or `docker exec docs-bot /opt/docs-bot/cook.sh`

If cook.sh fails, the loop logs and continues.

## Image and compose

Share `localhost/atlas-bot:latest`. Own volume `docs-bot-data`, bind `/opt/docs-bot`, PID 1 is `loop.sh`.
Do not share atlas-bot or lock-bot data volumes. Do not register a Forgejo runner.
Do not publish 8787. Do not include atlas-bot or lock-bot in this compose file.

## Hard no

Never privileged. Never mount the host container socket. Never mount `/stack` except the secrets env_file.
Never take atlas-bot or ai-proxy down. Do not merge PRs. Deploy is a host operator job.
