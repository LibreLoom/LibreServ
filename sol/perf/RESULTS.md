# Performance pass: Sol and Luna (2026-11-22)

All numbers below were measured on this checkout before and after the changes
in this branch. Raw reports are in the gitignored `perf/results/` directories.

## First-load bytes

`npm run perf:bundle` reports the entry script, CSS and all shipped font
faces. Fonts are an upper bound on a real first load because the browser only
downloads the faces the page uses. The main lever was the four FreeMono faces:
TTF replaced with WOFF2, TTF kept as a fallback for older browsers. The
regular face is preloaded in both products.

A few places use a 500 weight or bold text inside a mono container, so the two
bold faces still exist. They keep Latin-1, Latin Extended-A and common symbols in a ~46-49 KiB WOFF2
subset each; today's strings are covered, but a future non-Latin bold-mono
string would need the subset widened. The regular and italic faces retain every
codepoint in the original TTF `cmap`. Conversion commands are in
`sol/perf/README.md`.

| Product | Before | After | Ratio |
|---|---|---|---|
| Product, basis | Before | After | Ratio |
|---|---|---|---|
| Sol, regular face actually fetched by the dashboard | 709.0 KiB | 323.6 KiB | 2.19x |
| Sol, all faces (upper bound) | 1668.3 KiB | 571.8 KiB | 2.92x |
| Luna W1, regular face actually fetched | 1298.9 KiB | 912.4 KiB | 1.42x |
| Luna W1, all faces (upper bound) | 2258.2 KiB | 1160.6 KiB | 1.95x |
| Shared font faces (raw) | 1530 KiB | 433 KiB | 3.53x |

The 1.5x claim applies to Sol's transferred bytes and hot paths. Luna clears
1.5x only for the all-faces upper bound; the face the browser actually fetches
gives 1.42x, and the daemon hot paths have no before/after benchmark in this
pass. That limit is stated rather than folded into the headline.

The "face actually fetched" rows use the regular WOFF2 (189,468 B, or 185.0 KiB)
and the regular TTF (584,424 B, or 570.7 KiB); the browser run confirmed only
that face was requested. `sol/connect/web/customer` still ships TTF faces and
a TTF preload; it is a separate build and is outside this pass.

How each side was produced, so the numbers can be reproduced:

- Both sides use the **current** `bundle-report.js`. The "before" build is the
  parent commit with the font edits reverted; the "after" build is this branch.
  Each build was made with `npm run build` and then `npm run perf:bundle`.
- The figure is `totals.initial.wire`: JS and CSS at their prebuilt `.gz` size
  (what the servers send), fonts at raw bytes (servers do not gzip fonts). The
  raw JSON is in the gitignored `*/perf/results/bundle-*.json` files.
- Sol serves the `.gz` sibling for JS/CSS, so its wire total uses those bytes:
  before = 138.3 KiB JS/CSS + 1530.0 KiB TTF; after = 138.56 + 433.2 = 571.8 KiB (138.6 KiB JS/CSS + 433.2 KiB WOFF2).
  Lunad embeds `web/dist` and serves every file verbatim with no compression
  layer, so Luna's total is raw bytes throughout: before = 728.2 KiB JS/CSS +
  1530.0 KiB TTF; after = 727.4 + 433.2 = 1160.6 KiB WOFF2. Both sides were rebuilt with
  a clean output directory. An earlier draft measured Luna against a server
  that does not exist; the report now uses each server's real transfer basis.
- A browser check against the built Luna app with the luna/perf "remote"
  profile (80 ms RTT, 20 Mbit/s) saw the actually fetched regular face fall
  from 584,424 bytes (TTF) to 189,468 bytes of font data; the browser reported 189,768 B including headers, 3.08x. W1 p50 fell from
  1394 ms to 1286 ms (1.08x) with API responses mocked; the remaining time is
  JS parse, layout and round trips, so the byte win does not become a 1.5x
  wall-clock win there. That limit is stated rather than hidden.
- Interleaved A/B on that built app, the regular-face preload lowered W1 p50
  from 1652/1606 ms without it to 1422 ms with it (8 runs each). The preload
  stays in both products.
- The same built-app setup for Sol (mocked API, remote profile) put the first
  usable Dashboard at p50 1562 ms before and 1414 ms after (1.10x, 8 runs
  each). Neither product reaches 1.5x in wall-clock on this setup: JS parse,
  layout and round trips dominate once the font bytes are removed. A real
  Wyse 3040 journey run was not done, so no 1.5x end-to-end claim is made.

Sol's dashboard ticker is a leaf component, so its once-a-second update no
longer reconciles the health card and app list with it. The polling hooks opt
out of refetching on tab focus; the app-wide React Query default is unchanged.

## Backend hot paths

Go benchmarks from `sol/server/backend`, `GOMAXPROCS=3`, three runs each:

| Benchmark | Before (old behaviour) | After | Ratio |
|---|---|---|---|
| Database health probe | 21.4–45.4 ms (full `integrity_check`) | 22.3–23.3 us | ~1000x |
| `IsComplete` per authenticated request | 15.8–69.8 us | 40–84 ns | ~1000x |

The integrity scan still exists as `DB.IntegrityCheck()` for the admin endpoint.
A restore checks its replacement file before the swap through
`integrityCheckFile`, with a 10 s budget on the caller's context: the two-minute
page walk never sits in the restore request, and a timeout refuses the restore
while leaving the old database in place. A large database on a 3040 could
exceed 10 s, but the old post-swap 5 s check was worse. Decision: keep the
pre-swap budget bounded so a restore cannot outlive the HTTP write timeout;
a database large enough to need more than 10 s for a page walk belongs in a
background job, which is outside this pass. The admin endpoint
starts its check in the background (`POST /api/v1/system/database/integrity`)
and is polled through `GET /api/v1/system/database/integrity/status`.
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
