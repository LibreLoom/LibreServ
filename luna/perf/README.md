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
| W10, W10:query | search keystroke / the new text rendered and the quick search sent (`FileSearch`) | the first rows of results for that text painted (a long answer paints 12 rows, then the rest). The quick search has no debounce. |
| W11 | search keystroke | results with a `meaning` or `photo` match rendered (same `/api/v1/search`) |
| W12 | office document opened (`FileViewer`) | EuroOffice `onDocumentReady` |
| W15 | page load at `/s/…` | the link's first screen (listing, album, form or upload box) |
| W16 | route change (`App.jsx` `PageOutlet`) | the routed page committed, after paint |

Timing points that would cost real users something (W8 checks thumbnails
after every scroll) run only in detailed mode: the spec turns it on, and in
devtools `sessionStorage.setItem("luna.perf", "1")` plus a reload does. The
module is inert until `initPerf()` (main.jsx) runs, so unit tests never see it.

W6 (scroll FPS) is sampled by the spec with `requestAnimationFrame`, in its
own test. A run stops after 180 s; `reached_end` and `scrolled_fraction` say
how far it got. W13/W14 (transfer throughput) are not covered yet.

W16 presses the navbar link with a raw mouse click at its centre:
`locator.click()` first runs its visibility and stability checks inside the
throttled page, which added about 40–80 ms to each sample in our runs.

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
right after building. It prints the bytes for the initial load, per-page chunks
and the largest lazy chunks, and writes `perf/results/bundle-latest.json`.
Lunad serves embedded `dist` files verbatim, so JS/CSS and fonts are both
counted at raw size. The initial-load figure includes **every shipped font face
under `fonts/` (an upper bound)**, not only the faces W1 actually fetches; a TTF
beside a WOFF2 is a fallback and is not counted. Excalidraw's canvas fonts are
lazy assets and are not part of W1.

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

## Desktop and Connect (luna/desktop, luna/connect)

Scripts live in `perf/clients/`. Each prints JSON lines; results are not
written into the repo.

**Desktop engine, no GTK** (`desktop.sh`, built from
`desktop/examples/clients_bench.rs`). Drives the real sync and backup engines
against a running lunad. `LUNA_DESKTOP_PERF=1` (set by the script) adds one
`K3 sync pass` line per full pass to stderr (remote walk, local walk, diff,
ledger save). The engine is pinned to one host core (`K_CPU`, default 5): the
desktop runs on the person's computer, not on the Luna, so only lunad sits in
the 3040 stand-in.

| Mode | Prints |
|---|---|
| `sync <remote> <local parent> [cycles] [edits]` | `K-first-pass` (start to first full pass done, i.e. synced), `K3` per idle cycle (30 s wait + one full pass: CPU ms, RSS), `K4` per edit: `idle` (engine waiting) and `mid-pass` (edit 0.5 s into a full pass), ms until Luna lists the new size |
| `backup <remote> <local dir>` | `K5`: Mbit/s and the CPU-bound ceiling (bytes / CPU s) |
| `walk <remote> <unused>` | one remote walk, 5 times: wall and CPU ms |

```sh
LUNA_URL=http://localhost:8098 LUNA_PASSWORD=… LUNA_DRIVE=<drive id> \
  perf/clients/desktop.sh sync library /path/to/local-parent 3 3
```

The local parent should already hold a copy of the remote folder (the first
pass then only compares). Edits append a line to small files, so the data set
drifts slowly; regenerate it with `luna-bench gen` when that matters.
`BENCH=<binary>` runs a prebuilt bench, for interleaved A/B runs.

**Desktop app, K1 and K2** (`desktop-gui.sh`). Starts the real GTK app on Xvfb
with a private D-Bus bus (no activatable services: no portal, keyring or
accessibility bus is started, and the real ones are never touched), a fresh
`HOME`, and a `session.json` signed in to lunad. K1 marks come from the app
(`LUNA_DESKTOP_PERF=1`, ms since exec, 10 ms steps): `tray` (tray service up),
`window` (window mapped), `session` (saved sign-in checked, Files or sign-in
screen shown). After the idle time it reads RSS and PSS. `K_PAIR=library:<local
parent>` adds a sync pair; `K_ARGS=--background` starts it as start-on-boot
does. Xvfb only has software GL (llvmpipe), which alone maps about 75 MB; run
once more with `GDK_DEBUG=gl-disable` to see the app's own share.

**Connect, C2 and C5** (`connect.sh`). `start <dir>` builds (or takes
`CONNECT_BIN`) and runs Luna Connect in dev mode on `C_PORT` (8099) with
everything in `<dir>`: config, SQLite DB, pack store. It mints `C_DEVICES`
(5000) unbound device tokens, registers `perf@example.test`, marks it verified
with a card, binds one Luna and gives it a public name. `c2` times
`GET /api/v1/status` with that Luna's token (`C_RUNS`, 200). `c5` uploads
`C_PACKS` (8) random 32 MiB packs, as lunad's cloud backup does, and prints
MB/s plus Connect's own `Server-Timing` split (body read to disk, store put,
DB commit). `CONNECT_WEB=<dist>` serves another web build. Production runs
PostgreSQL and Backblaze B2; this measures SQLite and the local store.

**Connect pages, C3 and C4** (`connect-pages.mjs`, uses `luna/web`'s
Playwright). C3: cold load of `/onboarding` to its first heading with no
"Loading...". C4: sign-in submitted to the Luna page's public address card.
Each sample is a fresh browser context. `C_CPU` (4), `C_NET`: `4g` = 9 Mbit/s
down, 1.5 up, 150 ms RTT (default); `slow4g` = 1.6/0.75 Mbit/s, 560 ms.
`C_EDGE_GZIP=1` (default) puts a gzip proxy in front, standing in for
Cloudflare's compression; Go's file server sends no compression. Locally the
page loads over HTTP/1.1 (6 connections), where Cloudflare serves HTTP/2, so
many small files cost more here than in production. `C_DEBUG=1` prints each
request's timeline.

```sh
perf/clients/connect.sh start /tmp/connect-perf
LUNA_CONNECT_URL=http://127.0.0.1:8099 node perf/clients/connect-pages.mjs
perf/clients/connect.sh c2 /tmp/connect-perf; perf/clients/connect.sh c5 /tmp/connect-perf
perf/clients/connect.sh stop /tmp/connect-perf
```

**Android A1** (needs a phone on adb, the app installed): `adb shell am start
-W -S -n net.plainskill.luna/.LoginActivity` a few times and read
`TotalTime` (cold start to the first frame of the next screen). Note whether
the installed build is a debug one (`dumpsys package net.plainskill.luna`
shows `DEBUGGABLE`): debug builds start slower than release.

Not measured here: C1 (tunnel overhead is Cloudflare's edge and
`cloudflared`, not Connect code), Android A2–A5 (A2 uploads the phone's
photos, A3/A4 need hours on a release build, A5 needs a scripted scroll).
K5 over loopback is bound by lunad in the stand-in, not the link; read
`cpu_bound_mbit_s` for the desktop's own share.
