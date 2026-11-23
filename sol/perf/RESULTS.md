# Performance pass: Sol and Luna (2026-11-22)

All numbers below were measured on this checkout before and after the changes
in this branch. Raw reports are in the gitignored `perf/results/` directories.

## First-load bytes

`npm run perf:bundle` reports the entry script, CSS and all shipped font
faces. Fonts are an upper bound on a real first load because the browser only
downloads the faces the page uses. The main lever was the four FreeMono faces:
TTF replaced with WOFF2, TTF kept as a fallback for older browsers. The
regular face is preloaded in both products.

The two bold faces are not used by the design: no code combines `font-mono`
with a bold weight. They keep Latin and common symbols in a ~30 KiB WOFF2
subset each. The regular and italic faces retain every codepoint in the
original TTF `cmap`. The conversion commands are in `sol/perf/README.md`.

| Product | Before | After | Ratio |
|---|---|---|---|
| Sol first-load asset bytes (all shipped faces) | 2013.9 KiB | 871.5 KiB | 2.31x |
| Luna first-load asset bytes (all shipped faces) | 1054.2 KiB | 596.4 KiB | 1.77x |
| Shared font faces | 1530 KiB | 388 KiB | 3.94x |

How each side was produced, so the numbers can be reproduced:

- Both sides use the **current** `bundle-report.js` (font-aware). The "before"
  build is the parent commit with the font edits reverted; the "after" build is
  this branch. Each build was made with `npm run build` and then
  `npm run perf:bundle` against that build's `dist`.
- The figure is the report's `totals.initial.gzip`: JS and CSS use their
  prebuilt `.gz` sizes (what the servers send), fonts use their raw bytes
  (servers do not gzip fonts). The raw JSON is in the gitignored
  `*/perf/results/bundle-*.json` files.
- Luna breakdown: before = 208.9 KiB JS+CSS + 845.2 KiB TTF; after = 208.4 KiB
  JS+CSS + 388.0 KiB WOFF2. The JS/CSS total is unchanged, as the diff implies.
- A browser check against Luna's dev server with an 80 ms emulated RTT saw the
  actually fetched regular face fall from 584,724 bytes (TTF) to 189,768 bytes
  (WOFF2), 3.08x. The same check's W1 timings were dominated by dev-mode and
  fake-backend overhead, so they are not used as a journey result.

Sol's dashboard ticker is a leaf component, so its once-a-second update no
longer reconciles the health card and app list with it. The polling hooks opt
out of refetching on tab focus; the app-wide React Query default is unchanged.

## Backend hot paths

Go benchmarks from `sol/server/backend`, `GOMAXPROCS=3`, three runs each:

| Benchmark | Before (old behaviour) | After | Ratio |
|---|---|---|---|
| Database health probe | 21.4–45.4 ms (full `integrity_check`) | 22.3–23.3 us | ~1000x |
| `IsComplete` per authenticated request | 15.8–69.8 us | 40–84 ns | ~1000x |

The integrity scan still exists as `DB.IntegrityCheck()`, runs after a database
restore, and is exposed at `GET /api/v1/system/database/integrity` for admins.
The setup cache has a 30-second safety TTL and explicit invalidation on
completion, factory reset, and state changes.

API-token validation now uses one JOIN instead of three round-trips and
throttles the visible `last_used_at` write to once a minute per token. Sol
Connect's `last_seen_at` UPDATE is conditional, so it still round-trips on
every device poll but writes the row at most once per 90 seconds; the admin
usage query gained a timestamp index.

## Luna daemon

Drive marker detection is cached for 60 seconds and validated by the marker
file on each hit. Photo work used to rescan the drive root for every image and
every thumbnail request. A proposed `/proc/meminfo` cache was removed after
review: a stale `MemAvailable` could keep handing out large decode caps during
a scan on the 2 GiB target.

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
