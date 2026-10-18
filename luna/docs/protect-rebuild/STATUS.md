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

## Phase 4 (private item backups): started, partly built

Plan and 18 briefs: `briefs/p4-plan.md`, `briefs/p4-T1.md` … `p4-T18.md`. Wave order is in the plan.
- **T1 done** (db tables and helpers for private scopes, empty module stubs, `for_row` call switch).
- **T2 (access_list.rs), T3 (private crypto, format.rs), T4 (run.rs sealer refactor), T5 (Connect private gate)** were being written by agents when this was pushed. They are in the last commit marked `wip`. They were **not** verified together:
  T2's tests could not compile until T3 added `PRIVATE_SNAPSHOT_DOMAIN` in `format.rs`.
  First step on the new machine: run the full suites, fix whatever fails, then continue with wave 2 (T6 to T9).
- T6 onward not started.

## Phase 5 (dashboard Backups card, See all backups, health checks, phrase reminders, desktop/Android): planned only partly

`briefs/p5-plan.md` and `p5-T1.md` … `p5-T7.md` exist. The planner was stopped mid-way: **`p5-T7.md` may be incomplete or missing the later tasks**, and the plan's cross-check task (trace every web fetch to its backend route and field names) still needs a brief. Re-read `p5-plan.md` against plan.md §8 and fill the gaps.

## How to test

- Rust (host has no `cc`): `distrobox enter dev -- bash -lc 'cd ~/Projects/LibreServ/luna && CARGO_TARGET_DIR=target/dbx cargo test -p lunad --lib <filter>'`
- Connect Go: `cd luna/connect`, `GOTOOLCHAIN=local` with the Go 1.27 toolchain on `PATH`, then `go vet ./... && go test ./...`
- Web: `cd luna/web && npx vitest run && npm run typecheck && npm run scan:colors`; same in `luna/connect/web`; `shared/ui`: `npx vitest run lib/cloud`.
- After pulling: `npm install` in `shared/ui` and `luna/connect/web` (new crypto packages).

## Known open items

- Removing the original Admin can leave older retained cloud copies unopenable by others (documented in plan.md).
- Move-signature replay window of 300 s (accepted).
- Overlapping purges of an unlinked Luna are possible after a crash retry; purging is idempotent.
- `gofmt` flags `luna/connect/internal/api/handlers/admin_console.go` (was unformatted before this work).
- The source-missing check in `run_once` has no direct test.
- `needed` on the Luna restore card compares counts only; phase 4 should compare snapshot ids and ignore private ones.
- Restore downloads every tree pack in one go (data packs are no longer downloaded).
- Desktop and Android have no Protect screens (plan §9); check by grep before assuming.

## Decisions recorded for phase 4

See the "Decisions taken in this plan" list in `briefs/p4-plan.md` (Connect links a private scope to a user id and auth key; one protection row per private item and destination; folders only; Admin removes a deleted owner's private backups all at once; recovered private index is read-only; no repacking of private packs; private sessions on Connect last 30 minutes).
