# Protect rebuild: status (2026-10-17)

Design: `plan.md` (same folder). Worker rules: `briefs/brief-common.md`, `briefs/brief-web.md`.
Method used so far: an Opus orchestrator wrote briefs, Haiku agents implemented them in parallel waves,
an Opus reviewer checked each phase, Haiku agents fixed its findings, then the phase was committed.
Nothing below needs that setup; a person can follow the briefs just as well.

## Done and committed

| Phase | What | Commit |
|---|---|---|
| 1 | Drive backups: protections model, engine, versions, manifest, Backups folder, shield sheet, status | 33af28a30 |
| 2 | Cloud backup core: chunks and packs, keys, recovery phrase, identity, Connect storage API, runs, cleanup, checks | d9f2a2d1d |
| 3 | Connect backup browser (unlock with phrase, by-user browse, versions, file and zip download, share links), Luna restore card after database loss, old backup_objects/bindings removed | 83ce1d209, review fixes fae9c307f |

Both phase 2 and phase 3 went through an Opus review and all findings were fixed.
Checks at fae9c307f: lunad lib 1126 passed, Go `vet` and tests clean, Connect web 160 passed, Luna web 1369 passed, `scan:colors` clean.

## Phase 4 and 5: done (2026-10-18)

| Phase | What | Commit |
|---|---|---|
| 4 | Private item backups: drive and cloud (owner-sealed), private restore, Connect private sessions and the Private items row | 78ac8ebe, 97088968, bf91ecc4 |
| 5 | Dashboard Backups card, See all backups, health checks, 90-day phrase reminder, Android and desktop upload copy ("Photo upload", "Folder upload") | see git log |

Each wave: Haiku agents implemented, a reviewer checked against the briefs, Haiku agents fixed the findings, then the
orchestrator re-ran every suite before committing. Checks at the phase 5 commit: lunad lib 1213 passed, `cargo clippy --workspace --all-targets -- -D warnings` clean, desktop 61, luna/web 1420 passed
(tsc, eslint, `scan:colors` clean), Connect web 185 passed, shared/ui `lib/cloud` 47 passed. Android's 76 unit tests were run by an agent and not re-run by the orchestrator.

## How to test

- Rust: `export PATH=$HOME/.cargo/bin:$PATH; cd luna && cargo test -p lunad --lib <filter>` (the Mint host has gcc)
- Connect Go (no host Go): `podman run --rm -v "$PWD":/src:Z -w /src/luna/connect -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local docker.io/library/golang:1.27 sh -c 'go vet ./... && go test ./...'`. `TestCheckEmailRejectsDuplicate` is flaky (about 1 run in 4).
- Web: `cd luna/web && npx vitest run && npm run typecheck && npm run scan:colors`; same in `luna/connect/web`; `shared/ui`: `npx vitest run lib/cloud`.
- Web installs: npm is not on this machine. With pnpm use `pnpm install --node-linker=hoisted`, then replace `node_modules/@libreloom/ui` with a symlink to `shared/ui` (pnpm copies `file:` deps, and the copy goes stale and breaks vitest on extensionless imports). Redo both after any change under `shared/ui`.

## Known open items

- Removing the original Admin can leave older retained cloud copies unopenable by others (documented in plan.md).
- Move-signature replay window of 300 s (accepted).
- Overlapping purges of an unlinked Luna are possible after a crash retry; purging is idempotent.
- `gofmt` flags `luna/connect/internal/api/handlers/admin_console.go` (was unformatted before this work).
- The source-missing check in `run_once` has no direct test.
- `needed` on the Luna restore card compares counts only (not changed in phase 4).
- Restore downloads every tree pack in one go (data packs are no longer downloaded).
- Desktop and Android have no Protect screens (plan §9); check by grep before assuming.

## Decisions recorded for phase 4

See the "Decisions taken in this plan" list in `briefs/p4-plan.md` (Connect links a private scope to a user id and auth key; one protection row per private item and destination; folders only; Admin removes a deleted owner's private backups all at once; recovered private index is read-only; no repacking of private packs; private sessions on Connect last 30 minutes).
