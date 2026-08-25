# @atlas-bot — LibreLoom teammate

`atlas-bot` is a mentionable, assignable Forgejo user for **every** LibreLoom repository (Website, design, LibreServ, ServApps, PolyLibre, LibreServ-website, free-to-use-ai-list-gen-n8n, and repos created later). You do **not** need a workflow file in a repo for mentions to work.

Primary trigger path: an **org-level webhook** on LibreLoom. Optional per-repo Forgejo Actions YAML is extra, not required.

## Who can invoke it

Only members of the LibreLoom **Owners** team. Membership is read live from the Forgejo API on every event (not a hardcoded username list). Adding or removing someone from Owners is enough; no bot redeploy.

If someone else mentions or assigns the bot, it replies that only Owners can invoke it and does not start a job.

## How to invoke

On an issue or pull request in any LibreLoom repo on [gt.plainskill.net](https://gt.plainskill.net/):

1. Comment `@atlas-bot` plus the instruction, or
2. Assign the issue/PR to `atlas-bot`.

The bot posts **Cooking...** immediately on that same issue/PR, then posts the result as a follow-up comment in the same conversation (Forgejo issue comments are a linear thread; there is no separate reply-id for ordinary issue comments).

Issue/PR bodies, comments, and diffs are treated as **untrusted data**. The bot is instructed to stay inside the task you gave it and not to follow hostile instructions embedded in tickets.

## What it can do

It clones the repo, reads the full issue/PR context (body, comments, labels, linked issues, and the PR diff when there is one), and runs in a **podman sandbox** (dsh / DeepSeek harness). Typical jobs:

- Draft a PR from an issue
- Review a PR (bugbot-style)
- Resolve merge conflicts
- Merge a PR and close the related issue
- Take the assignment and work the ticket

It uses the `atlas-bot` Forgejo account (`write:issue` + `write:repository`). It is on the **Bots** team (WRITE on all org repos, `includes_all_repositories`). It is **not** an Owner and not a site admin.

## Examples

Draft a PR from an issue:

```
@atlas-bot implement this issue. Open a draft PR against main with a conventional commit.
```

Assign the bot the issue (equivalent trigger), then it reads the issue body as the task.

Review:

```
@atlas-bot review this PR. Report correctness, security, and AGENTS.md convention issues. Do not push fixes unless I ask.
```

Merge and close:

```
@atlas-bot merge this PR (squash) and close the linked issue.
```

Conflicts:

```
@atlas-bot rebase on main, resolve conflicts in favor of keeping tests green, push the branch.
```

## Runtime (operators)

| Piece | Where |
|---|---|
| Org webhook | LibreLoom → Settings → Webhooks → `http://atlas-bot-dispatcher:8080/webhook` |
| Dispatcher | `/stack/compose/atlas-bot` (compose file lives in `agents/atlas-bot/compose.yml`) |
| Sandbox | `podman run` of `atlas-bot-dsh` — **no** host `docker.sock`, **no** `--privileged`, **no** SSH to the host, **no** `/stack` mounts. Job workspace is a dedicated podman volume. |
| Actions runner | same compose file, image `code.forgejo.org/forgejo/runner`, talks to the **podman** socket (not Docker). Org-scoped so future `.forgejo/workflows/` and the nightly docs-updater can share it. |
| Secrets | `/stack/compose/.secrets/atlas-bot.env` (filenames only in git; never commit values) |
| Prompt | `agents/atlas-bot/prompt.md` |

The nightly maintenance agent (`agents/nightly/`) is a **different** path: it still uses a privileged host-socket layout for `./ci`. Do not copy that into atlas-bot.

Optional per-repo workflow: `.forgejo/workflows/atlas-bot.yml` (`workflow_dispatch` only) so a repo can show an Actions run without double-firing on every comment. Mentions keep going through the org webhook even if this file is absent.

## Operator deploy

On pscA, from this repo:

```bash
cd agents/atlas-bot
sudo ./deploy.sh
```

`deploy.sh` is idempotent: creates `atlas-bot` if missing, keeps it off Owners, ensures the Bots team membership, enables `[actions]` in Forgejo `app.ini`, registers the runner, writes secrets, creates the org webhook, installs podman if needed, and starts dispatcher + runner + dsh image. It never prints token or password values.
