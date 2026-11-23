# Performance pass: Sol and Luna (2026-11-22)

All numbers below were measured on this checkout before and after the changes
in this branch. Raw reports are in the gitignored `perf/results/` directories.

## First-load bytes

`npm run perf:bundle` reports what a first load actually downloads. The main
lever was the four FreeMono faces: 1.6 MiB of TTF replaced with 545 KiB of
WOFF2 carrying every glyph, with the TTFs kept as a fallback for older
browsers. The regular face is preloaded.

| Product | Before | After | Ratio |
|---|---|---|---|
| Sol initial download | 2013.9 KiB | 1029.5 KiB | 1.96x |
| Luna font faces (shared) | 1530 KiB | 545 KiB | 2.81x |

Sol's dashboard ticker is a leaf component, so its once-a-second update no
longer reconciles the health card and app list with it. Tab-focus refetches
were turned off because the dashboard queries already poll.

## Backend hot paths

Go benchmarks from `sol/server/backend`, `GOMAXPROCS=3`, three runs each:

| Benchmark | Before (old behaviour) | After | Ratio |
|---|---|---|---|
| Database health probe | 21.4–45.4 ms (full `integrity_check`) | 10.3–11.0 us | ~2000x |
| `IsComplete` per authenticated request | 15.8–69.8 us | 40–84 ns | ~1000x |

The integrity scan still exists as `DB.IntegrityCheck()`, runs after a database
restore, and is exposed at `GET /api/v1/system/database/integrity` for admins.
The setup cache has a 30-second safety TTL and explicit invalidation on
completion, factory reset, and state changes.

API-token validation now uses one JOIN instead of three round-trips and
throttles the visible `last_used_at` write to once a minute per token. Sol
Connect's `last_seen_at` write is debounced to 90 seconds, matching Luna
Connect, and the admin usage query gained a timestamp index.

## Luna daemon

Drive marker detection is cached for 60 seconds and validated by the marker
file on each hit. Photo work used to rescan the drive root for every image and
every thumbnail request. `/proc/meminfo` parsing is cached for 30 seconds in
the memory-budget path, which photo scans call per image.

## Verification

- `go build ./...` and `go vet` pass for both Go modules.
- `npm run typecheck` and `npm run lint` pass for both web apps (only
  pre-existing warnings in untouched files).
- `npm run scan:colors` passes for Sol. Luna's scan reports two pre-existing
  hex values in untouched test files (`FileSearch.test.jsx`,
  `FileSearchRow.test.jsx`).
- Targeted Go tests pass (`internal/database`, `internal/setup`, `internal/auth`,
  `internal/api/handlers/system`, `internal/api/middleware`), as do Sol's
  Dashboard tests and Luna's PhotoThumb and FileBrowser tests. One Luna
  PublicSharePage form test fails identically on clean HEAD, so it is not from
  this branch.
- `cargo check -p lunad` with Rust 1.99.1.

## What is not claimed

These are transfer-size and hot-path measurements, not a full browser journey
run on the Wyse 3040 stand-in. The existing `luna/perf` harness remains the
source of truth for W/D/K/C journeys. Several of those journeys sit at a
network or hardware floor and a 1.5x end-to-end improvement there would be
dishonest to claim without a clean A/B run.
