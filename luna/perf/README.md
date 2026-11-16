# Luna performance budgets

`budgets.json` is the single list of user journeys and their goals. Every
timing point in the code carries its journey ID (`W4`, `D5`, …) so a result
maps straight back to a budget.

- **Reference hardware:** Dell Wyse 3040 (2 GiB RAM). Times are p95.
- **Approach:** measure the journeys, profile only what is over budget, fix,
  measure again. Commits that claim a speed-up carry before/after numbers.
- **Data:** generated fixtures live in `perf/data/` and results in
  `perf/results/`; both are gitignored.
- **Runs need the user's go-ahead** (see AGENTS.md → Running tests).

Where each product is measured is described in the sections below as the
harness lands.

## Web (luna/web)

**Timing points.** `web/src/lib/perf.js` wraps `performance.mark/measure`
with journey IDs and keeps the measures, long tasks and largest contentful
paint on `window.__lunaPerf` (also visible in the browser's Performance
panel as `luna:W…`). No UI, nothing sent anywhere.

| ID | Starts | Ends |
|---|---|---|
| W1 / W2 | page load (time origin) at `/` | Dashboard's drives and recents answered, after paint (`DashboardPage`). The app always names it W1; the spec calls the reload W2. |
| W3 | sign-in submitted (`LoginPage`) | Dashboard usable |
| W4 / W5 | folder path changes (`FileBrowser`, dated from the click) | that folder's own listing rendered (not the previous folder's placeholder) |
| W7 | Photos page mounts | every timeline thumbnail in the viewport loaded |
| W8 | a scroll on the timeline comes to rest (`scrollend`); detailed mode only | same as W7. No scrubber exists yet, so this is an approximation. |
| W9, W9:full | photo opened (`PhotosPage.openPhoto`) | preview, then full photo decoded (`LightboxMedia`, current pane only) |
| W10, W10:query | search keystroke / debounce fires (`FileSearch`) | results for that text rendered. The 250 ms debounce is inside W10. |
| W11 | search keystroke | results with a `meaning` or `photo` match rendered (same `/api/v1/search`) |
| W12 | office document opened (`FileViewer`) | EuroOffice `onDocumentReady` |
| W15 | page load at `/s/…` | the link's first screen (listing, album, form or upload box) |
| W16 | route change (`App.jsx` `PageOutlet`) | the routed page committed, after paint |

Timing points that would cost real users something (W8 checks thumbnails
after every scroll) run only in detailed mode: the spec turns it on, and in
devtools `sessionStorage.setItem("luna.perf", "1")` plus a reload does. The
module is inert until `initPerf()` (main.jsx) runs, so unit tests never see it.

W6 (scroll FPS) is sampled by the spec with `requestAnimationFrame`. W13/W14
(transfer throughput) are not covered yet.

**Journey run** (`web/perf/journeys.spec.js`, config
`web/playwright.perf.config.js`). Point it at a real lunad serving the
**built** app: the dev server boots the fake lunad and StrictMode, so it has
no `webServer`. Results go to `perf/results/web-journeys-<run>.json` and
`web-journeys-latest.json` (p50/p95 per journey against `budgets.json`;
over-budget is reported, not failed).

```sh
cd luna/web
LUNA_PERF_BASE_URL=http://127.0.0.1:8090 \
LUNA_PERF_PASSWORD=… \
LUNA_PERF_FOLDER_SMALL=<driveId>:<folder with 200 items> \
LUNA_PERF_FOLDER_LARGE=<driveId>:<folder with 10,000 items> \
LUNA_PERF_SEARCH_NAME=report LUNA_PERF_SEARCH_MEANING="dog on a beach" \
LUNA_PERF_CPU_THROTTLE=6 \
npm run perf:journeys
```

| Variable | Default | Meaning |
|---|---|---|
| `LUNA_PERF_BASE_URL` | `http://127.0.0.1:8090` | Luna to measure |
| `LUNA_PERF_USER` / `LUNA_PERF_PASSWORD` | `admin` / — | account; without a password every journey skips |
| `LUNA_PERF_RUNS` | 10 | repeats per journey |
| `LUNA_PERF_LOGIN_RUNS` | 5 (max 8) | W3 repeats. lunad allows 10 sign-in tries per 5 min; the run signs in only for W3 and reuses that session. |
| `LUNA_PERF_JOURNEYS` | all | e.g. `W4,W5,W6` |
| `LUNA_PERF_CPU_THROTTLE` | 1 | Chrome CPU slowdown factor (CDP). Calibrate once: pick the factor where a fast machine's W1 matches a real 3040. |
| `LUNA_PERF_NETWORK` | `lan` | `remote` adds 80 ms latency, 20/5 Mbit/s and compares with `remote_ms` |
| `LUNA_PERF_FOLDER_SMALL` / `_LARGE` | — | `driveId:path` for W4 / W5 and W6 |
| `LUNA_PERF_SCROLL_RUNS` / `_STEP` | 3 / 120 px | W6 runs and pixels scrolled per frame |
| `LUNA_PERF_SEARCH_NAME` / `_MEANING` | — | W10 / W11 query |
| `LUNA_PERF_OFFICE_DOC` | — | `driveId:path/doc.docx` for W12 (needs the office pack) |
| `LUNA_PERF_OFFICE_RUNS` | 5 | W12 repeats |
| `LUNA_PERF_SHARE` | — | `/s/<token>` link for W15 |

A sample whose start landed over 100 ms after the spec's action counts in
`late_starts`: the app replaced the real start, so that number is too low.
Every journey runs in a fresh browser context (cold HTTP and React Query
caches) except W2 (a reload) and W16 (one session clicking the navbar).

**Bundle size.** `npm run perf:bundle` reads the last build
(`crates/lunad/web/dist`), or `LUNA_BUNDLE_REPORT=1 npm run build` writes it
right after building. It prints gzip sizes for the initial load (what W1
downloads), per-page chunks and the largest lazy chunks, and writes
`perf/results/bundle-latest.json`.

## lunad (crates/lunad)

**Switching it on.** All lunad timing logs at the `lunad::perf` target and
is off by default (one atomic load per hook). Start lunad with
`LUNA_PERF=1` for request lines, job timings and resource samples, or
`LUNA_PERF=debug` to add per-item timings. `RUST_LOG=…,lunad::perf=debug`
works too. Every line has the message `perf` and a `journey` field, so
`grep ' perf'` pulls them out of the log.

| What | Where | Journey |
|---|---|---|
| Each request: method, matched route (never the raw path or query), status, ms to response headers; `Server-Timing: total;dur=…` header | `perf::http_timing`, layered last in `main.rs` (includes auth) | W3–W15 server side |
| Start to listening, plus `usb_wait_ms` (lunad waits until 8 s of uptime for USB drives) | `main.rs` | D1 |
| File name scan per drive (`files.scan`: `force`, `dirs`) | `files/search_indexer.rs` | D4 / D6 |
| Reading file contents per drive (`files.content`; full passes at info) | `files/content/indexer.rs` | D4 |
| Photos catch-up per drive (`photos.scan`: found, thumbnailed, failed) | `photos/photos_indexer.rs` | D4 / D5 |
| New photos arriving while Luna runs, per settled batch (`photos.new`: count) | `photos/photos_indexer.rs` | D5 |
| One thumbnail (`photos.thumb`, kind image/heic/video; debug) | `photos::ensure_thumb` | D5 |
| Search request (`search`); neural passes `search.meaning`, `search.photos`, `search.photo_query` (debug) | `api/search.rs`, `files/search.rs` | W10 / W11 |
| Cloud backup run (`backup.cloud`: files, uploaded bytes) | `backup/cloud/ops.rs` | D7 |
| Drive backup run (`backup.drive`: copied, unchanged) | `backup/drive_backup.rs` | D8 |
| Every `LUNA_PERF_SAMPLE_SECS` (default 30): RSS, peak RSS (VmHWM), CPU s and %, voluntary context switches per minute (the closest `/proc` proxy for wakeups), threads, MemAvailable | `perf::spawn_sampler` | D2, D2b, D3, M2 |

Caveats: request time stops at the response headers, so download time (W14)
is measured by the bench, not the log. There is no DB time: handlers query
on blocking threads. RSS is lunad alone; `heif-dec`, `ffmpeg` and the
content reader run as child processes. The sampler's own tick counts as a
wakeup, so for D3 set `LUNA_PERF_SAMPLE_SECS=600` or measure with perf off.

**Test data** (`luna-bench gen`). Writes one mock drive,
`perf/data/drives/luna-perf/`, with `folder_small/`, `folder_large/`, `library/`
(a household tree, sizes log-uniform per file type, files over
`--dense-max-kb` sparse) and `photos/<year>/<month>/` (JPEG with EXIF date,
camera and GPS; a share HEIC when `heif-enc` or ImageMagick with HEIC is
installed). `--preset quick` (default) is small; `--preset full` matches
`budgets.json`.

```sh
cd luna
cargo run --release -p luna-bench -- gen --preset quick   # --help for sizes
# Every folder in perf/data/drives becomes a drive; `only` hides this machine's real disks.
LUNA_MOCK_DRIVES=only LUNA_MOCK_DRIVES_PATH=$PWD/perf/data/drives LUNA_PERF=1 \
  cargo run --release -p lunad --bin lunad -- --data-dir $PWD/perf/data/lunad
# then finish setup and add the luna-perf drive in the browser
```

**Bench** (`luna-bench run`). Signs in once (the session works as a bearer
token), times N requests per journey after a warmup, and writes
`perf/results/bench-<time>.json` with p50/p95, lunad's own `Server-Timing`
p95 when perf is on, and the budget. Web journeys are server side only, so
they can be over budget here but never proven within it.

| ID | Requests |
|---|---|
| W4 / W5 | `GET /api/v1/drives/{id}/files?path=folder_small` / `folder_large` |
| W7 | timeline page, then the first 24 thumbnails 6 at a time |
| W9 | `photos/preview`, and `files/content` for the `full_ms` budget; a different photo each round |
| W10 / W11 | `GET /api/v1/search` typed letter by letter / a phrase (one endpoint; split them with `LUNA_PERF=debug`) |
| W13 / W14 | chunked upload of `--upload-mb` (default 64) / download it back; Mbit/s against `--link-mbps` |
| W15 | makes one view link on `folder_small`, times a guest's `/s/{token}?meta=1` + `/list`, deletes it |
| D1 | `--spawn CMD` starts lunad, times until `/health` answers, repeats |

```sh
cargo run --release -p luna-bench -- run --user admin --password … \
  --iterations 20 --profile lan --link-mbps 940
cargo run --release -p luna-bench -- run --journeys D1 \
  --spawn 'env LUNA_PERF=1 LUNA_MOCK_DRIVES=only LUNA_MOCK_DRIVES_PATH=perf/data/drives target/release/lunad --data-dir perf/data/lunad'
```
