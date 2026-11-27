# Luna optimization results (2026-11-16)

Measured on the Wyse 3040 stand-in (see README.md): lunad in a container
with `--cpus=0.7 --memory=2g` and a 2 GiB `/proc/meminfo`, synthetic data
from `luna-bench gen`, browser at CPU throttle 4. The host CPU has AVX2,
which the 3040's Atom lacks, so SIMD-heavy paths (thumbnails) are a little
optimistic. Raw results are in `perf/results/` (gitignored):
`baseline-1/` and `web-journeys-baseline-1-*.json` for before,
`final/` and `web-journeys-final-{lan,remote}.json` for after.

"Before" is the baseline at the start of the work; "after" is HEAD at
42a090ca, measured in one clean pass with nothing else running.

## Web, browser p95 (ms)

| Journey | Budget LAN | LAN before | LAN after | Remote before | Remote after (budget) |
|---|---|---|---|---|---|
| W1 cold load to Dashboard | 1500 | 902 | 626 | 2423 | 1255 (3000) |
| W2 warm load | 600 | 615 | 353 | 1531 | 634 (1200) |
| W3 sign-in to Dashboard | 500 | 705 | 544 ⚠ | 978 | 803 (1000) |
| W4 open folder | 250 | 828 | 377 ⚠ | 1012 | 442 (600) |
| W5 open large folder | 800 | 1383 | 464 | 1690 | 631 (1500) |
| W6 scroll large folder (min fps) | 60 fps | 10.8 | 20.5 ⚠ | 12.7 | 20.6 ⚠ |
| W7 Photos timeline, first thumbnails | 1000 | 2521 | 1140 ⚠ | 2439 | 1561 (2000) |
| W8 timeline scrub, thumbnails after stop | 300 | 2220 | 513 ⚠ | 2543 | 1899 ⚠ (300) |
| W9 open photo in viewer | 300 | 379 | 299 | 101 | 93 (2000) |
| W10 name search | 150 | 2162 | 373 ⚠ | 1227 | ~339 (400) |
| W15 public share link | 1500 | 1318 | 703 | 1826 | 2231 (2500) |
| W16 page navigation | 150 | 459 | 106 | 401 | 151 ⚠ (150) |

⚠ = still over budget. W10 "after" is from b721eb10's A/B run (n=30, first
12 rows painted); the clean pass at 42a090ca had 706 LAN / 792 remote. Its
150 ms LAN budget can't be met with the 120 ms typing debounce. W3 is 5 samples (sign-in rate limit), so p95 is
the worst one; the round-3 A/B gave 656 → 453. W11 (meaning search) and
W12 (office) were not measurable: the stand-in has no models or office pack.

## lunad, server p95 (ms, luna-bench LAN)

| Journey | Before | After |
|---|---|---|
| W10 name search | 1468 | 106 |
| W11 search, long phrase (no models pack) | 480 | 53 |
| W14 download a large file | 2035 | 315 |
| W13 upload 256 MB | 1181 | 994 |
| W7 timeline + 24 thumbnails | 580 | 79 |
| W5 large folder | 136 | 80 |
| W9 photo preview | 56 | 43 |

## Box (D, M)

| Journey | Before | After |
|---|---|---|
| D1 start-up | 1.6–1.8 s | 1.5 s |
| D2 idle RSS | 38–41 MB | 42 MB (peak 74 MB under the web run) |
| D3 idle wakeups | ~614 switches/min, 688 processes spawned / 10 min | 38/min, 1 spawned (fresh box); ~120/min after use |
| D5 photo thumbnail, one Atom-like core | 5.3 s | 1.8 s |
| D5 200-photo scan in the container | 166.5 s, 100 MB peak | 78.7 s, 78 MB peak |
| D6 rescan | < 0.4 s | 0.15–0.34 s |

D3 after use is higher than on a fresh box: once anything is cached the
RAM-pressure loop ticks every 5 s, and the 30 s perf sampler itself adds
wakeups. The HDMI console refresh (10 s) is the floor on a fresh box.

## What changed

- lunad: thumbnails via fast_image_resize and up to 3 scan workers; photo
  watcher ignores Luna's own files (it used to rescan forever); drive DB
  migrates once; uploads off the async runtime with 256 KiB chunks; photo
  listing SQL limited; thumbnail semaphore; health check and fstrim off the
  lock; auth activity writes deduped; search indexer blocks when idle;
  cloud backup reuses unchanged chunks; folder index diffs instead of
  rewriting; scrub and job progress batched; name search answers first
  (`quick=1`) and skips the typo pass when exact names fill the answer;
  idle threads wait on events (netlink, Condvar, Notify) instead of timers.
- Web: drive polling every 15 s; vendor chunk split; lazy file-task card;
  indexing back-off; preloaded pages render without the 300 ms fallback
  wait; /login preloads the Dashboard; folders fetch during the opening
  render and mount fewer rows first; icon-only row buttons skip resize
  probes; search shows name hits before photos and meaning.
- Android: uploaded-file log, 8 MiB chunks, foreground service started
  only when needed. Desktop: remote mtime fix, ledger batching, blocking
  work off the UI thread. Connect: pack uploads outside the write lock,
  reachability cache, device index by account, smaller entry chunk. These
  came from the code scan and pass their tests; their journeys (A, K, C)
  were not measured, because there is no phone, desktop or Connect stand-in.

## Open

- D5 first scan of a large library still misses its 20-minute budget on a
  3040, mostly HEIC (a full HEVC decode is ~2.5 s per photo). Options:
  a fast first thumbnail from the embedded preview, or a relaxed budget.
- W4/W6: each file row carries ~8 icon buttons with tooltips; lighter rows
  are the next step.
- W8 remote: thumbnails after a scrub take ~1.9 s over the tunnel; fewer,
  smaller first requests would help.
- D3: event-driven HDMI console, cache expiry, cloudflared child watch.

## Round 4 (d384592e … e8a9eeb9)

Measured by interleaved A/B on separate stand-ins, HEAD before vs after,
so machine load hits both sides equally. Not yet in a clean whole-suite
pass: the pass at e8a9eeb9 ran while another session on the machine was
compiling (load avg ~10; even untouched W1/W2 doubled and D1 start-up went
1.5 → 6.4 s), so those numbers (`results/final-2/`) are not used here.

| Journey | Before | After | Budget |
|---|---|---|---|
| W4 open folder, p95 | 513 ms | 225 ms | 250 ✅ |
| W6 large-folder scroll, min fps | 7 | 28 | 60 ⚠ |
| W10 name search, p95 | 366 ms | 241 ms | 150 ⚠ |
| W8 remote scrub, p95 | 2224 ms | 1021 ms | 300 ⚠ |
| D5 first stage, 200 mixed photos | 83.8 s | 25.1 s | 24 s (scaled) ⚠ |
| D5 scan peak RSS | 77 MB | 46 MB | |
| D3 idle after use, switches/min | 109–118 | 42–48 | ~1 ⚠ |
| K4 desktop edit reaches Luna | never | 514–638 ms | 5000 ✅ |
| K3 desktop no-change pass, 50k files | 1720 ms | 1040 ms | 2000 ✅ |
| Desktop engine RSS after sync | 62–69 MB | 24–32 MB | |
| C3 Connect onboarding cold load, p95 | 1444–1681 ms | 940–1290 ms | 1500 ✅ |
| C4 Connect dashboard after sign-in, p95 | 995–1126 ms | 851–978 ms | 1000 ✅ |

Also measured, within budget with no change: K1 desktop start 70–320 ms
(1000), C2 device status p95 2.6–3.1 ms (50). Still over: K2 desktop idle
memory 71 MB vs 60 (GTK/libadwaita base ~53 MB); A1 Android cold start
1581–1894 ms vs 1500 on a debug build (not replaced, to keep the phone's
data). W3 and W7 were under budget on the round-4 stand-in (390/761 ms).

Desktop also had two real bugs fixed on the way: edits to existing files
never uploaded, and a signed-in app could hang on "Checking your sign-in".

## Round 5 (in 464a840b "checkpoint")

Interleaved A/B, 3+ pairs each, on separate 3040 stand-ins:

| Journey | Before | After | Budget |
|---|---|---|---|
| D3 idle, fresh box, switches/min | 43–45 | 1.4 | ~1 ≈ ✅ |
| D3 idle after use, switches/min | 38–42 | 4.8–5.2 | ~1 ⚠ |
| D5 first stage, 200 mixed photos | ~24.6 s | ~16.3 s | 24 s ✅ |
| W10 quick name answer, server p95 | ~70 ms | ~50 ms | — |
| HDMI screen shows a new address | 6.5–7 s | 0.1–1 s | — |

How: the HDMI status redraws only on change (netlink, a SQLite update
hook, Connect status) with a 5-min heartbeat; its "not updating" note now
appears after ~12 min instead of 90 s. Background jobs sleep until their
window or a nudge. Photo decodes during a scan are held to one CPU per
worker. Name search sorts without cloning, reads each pass in one
statement and keeps a per-drive connection for 3 s (an eject right after
a search may retry for a moment).

## Clean final pass at d06d9cc9 (2026-11-17)

Whole suite on the 3040 stand-in, nothing else running (host load ≤ 2.4,
no other containers). Raw: `results/final-4/`, `web-journeys-final4-*.json`.

| Journey | Baseline LAN | Final LAN | Budget | Final remote (budget) |
|---|---|---|---|---|
| W1 cold load | 902 | 710 | 1500 ✅ | 1686 (3000) ✅ |
| W2 warm load | 615 | 404 | 600 ✅ | 783 (1200) ✅ |
| W3 sign-in | 705 | 397 | 500 ✅ | 443 (1000) ✅ |
| W4 open folder | 828 | 237 | 250 ✅ | 370 (600) ✅ |
| W5 large folder | 1383 | 325 | 800 ✅ | 473 (1500) ✅ |
| W6 scroll, min fps | 10.8 | 45 | 60 ⚠ | 45 ⚠ |
| W7 photos timeline | 2521 | 1132 (p50 590) | 1000 ⚠ | 1074 (2000) ✅ |
| W8 scrub | 2220 | 565 (p50 134) | 300 ⚠ | 974 (—) ⚠ |
| W9 open photo | 379 | 128 | 300 ✅ | 83 (2000) ✅ |
| W10 name search | 2162 | 217 (p50 153) | 150 ⚠ | 299 (400) ✅ |
| W15 share link | 1318 | 582 | 1500 ✅ | 2035 (2500) ✅ |
| W16 page switch | 459 | 102 | 150 ✅ | 145 (150) ✅ |

lunad (luna-bench LAN p95): W10 1468 → 70 ms, W11 480 → 46, W14 2035 →
304, W13 1181 → 1064, W7 580 → 77, W5 136 → 75. D1 start-up 1.8 s. Idle
after start-up: ~19 MB RSS, 4–6 voluntary switches/min with the 30 s perf
sampler itself running.

Still over: W6 (45 vs 60 fps at 4× CPU slowdown), W7 and W8 LAN p95 (one
slow sample each; p50 well under), W10 LAN (the 30 ms debounce plus
~70 ms server p95 and the render leave little room for 150 ms), W8 remote
(no remote budget set), D3 after use (~5/min), K2 desktop idle memory
(71 MB, GTK base), A1 Android cold start (debug build only).

## Round 6 and clean pass at 88e37540 (2026-11-17)

Round 6: file-row icons drawn as cached images instead of inline SVGs,
quick name search without the 30 ms wait, no idle prefetch of every
Places point (~11 MB JSON), pages preloaded one at a time, and the RAM
cache sleeping to its expiry when kernel stall reports watch memory
(D3 after use 5.0–5.2 → 2.4–2.6 switches/min, 3 pairs).

Clean whole-suite pass (host load ≤ 1.6, nothing else running; raw in
`results/final-5/`, `web-journeys-final5-*.json`):

| Journey | LAN p95 | Budget | Remote p95 (budget) |
|---|---|---|---|
| W1 cold load | 565 | 1500 ✅ | 1019 (3000) ✅ |
| W2 warm load | 362 | 600 ✅ | 602 (1200) ✅ |
| W3 sign-in | 443 | 500 ✅ | 512 (1000) ✅ |
| W4 open folder | 218 | 250 ✅ | 300 (600) ✅ |
| W5 large folder | 355 | 800 ✅ | 457 (1500) ✅ |
| W6 scroll | 59.4 fps, max frame 83 ms | 60 fps, 50 ms ⚠ | 59.4 fps, 67 ms ⚠ |
| W7 photos timeline | 616 | 1000 ✅ | 910 (2000) ✅ |
| W8 scrub | 144 | 300 ✅ | 809 (—) ⚠ |
| W9 open photo | 150 | 300 ✅ | 100 (2000) ✅ |
| W10 name search | 132 | 150 ✅ | 281 (400) ✅ |
| W15 share link | 692 | 1500 ✅ | 3816, p50 1083 (2500) ⚠ |
| W16 page switch | 112 | 150 ✅ | 137 (150) ✅ |

lunad LAN p95: W10 65 ms, W11 51, W13 929, W14 295. D1 start-up 2.5 s.
W6 now holds ~60 fps but has 3–5 frames over 50 ms per run; W15 remote's
over-budget sample is the first open through a new tunnel (the other four
are ~1.1 s).

## Round 7 (in 9fee6c16 "checkpoint") and passes at 3553b70d (2026-11-18)

Round 7, interleaved A/B (n=9–20 per side): W6 LAN frames over 50 ms
336 → 0, worst frame 83–200 → 33–50 ms; W8 remote p95 878 → 587 ms;
W15 remote p95 1662 → 1273 ms; D3 after use 4.7–7.9 → 1.0–3.2
switches/min. How: only visible rows re-render while scrolling; photo
thumbnails load nearest-first instead of `loading="lazy"`; a share link
fetches its listing while the page code loads; Connect, DHCP, console
help and the backup key mover wait on events; search rescans a watched
drive every 6 h (changes arrive through the drive watch in between).
W15's slow first remote sample is the tunnel warming up (lunad answers
in < 3 ms).

Two whole-suite passes at HEAD; the host is shared and was not quiet:

| Journey | final-6 LAN (load ≤ 2) | final-7 LAN (load 2–3.8) | final-7 remote (load ≤ 5) | Budget LAN / remote |
|---|---|---|---|---|
| W1 | 748 | 880 | 1184 | 1500 / 3000 |
| W3 | 472 | 579 | 456 | 500 / 1000 |
| W4 | 193 | 250 | 259 | 250 / 600 |
| W6 min fps, max frame | 59.8, 33 ms | 55, 50 ms | 46, 133 ms | 60, 50 ms |
| W7 | 754 | 844 | 1409 | 1000 / 2000 |
| W8 | 68 | 112 | 836 (p50 491) | 300 / — |
| W10 | 139 | 168 | 331 | 150 / 400 |
| W15 | 616 | 661 | 1378 | 1500 / 2500 |
| W16 | 125 | 168 | 223 | 150 / — |

On a quiet host every LAN journey is within budget (final-6). Under load
from other work on the host, W3, W6, W10 and W16 slip just past. The one
journey over on every remote pass is W8: thumbnails after a scrub through
the tunnel (p50 ~400–500 ms); it has no remote budget, and the 300 ms LAN
one is about two tunnel round trips. Luna CI passed at 3553b70d (one
PublicSharePage test failed under load in the first run, passed on the
re-run and 3/3 alone).

## Rounds 8–10 (f4bc4cca … 55c370ab, 2026-11-18)

Interleaved A/B on the stand-ins (HEAD before vs after):

| Journey | Before | After | Budget |
|---|---|---|---|
| D3 idle after use, switches/min | 1.9–2.1 | 0.6 | ~1 ✅ |
| K2 desktop idle RSS, window open | 66.7 MB | 55.1 MB | 60 ✅ |
| K2 desktop, started in background | 46 MB | 40 MB | 60 ✅ |
| A1 Android cold start, release build (n=12) | — | p50 555, p95 719 ms | 1500 ✅ |
| W8 remote scrub, p50 / p95 | 436 / 602 | 289 / 339 | 300 (LAN) ⚠ p95 |
| W3 / W10 / W16 under load 8–10, p95 | 1451 / 543 / 591 | 1111 / 466 / 364 | — |

A1's earlier 1.6–1.9 s came from the debug build only. How: one clock
thread for lunad's slow timers and a write-free health check; the HDMI
console checks a lunad lock file with a 30-min heartbeat (a hung, still
running lunad shows "not updating" after ~62 min); desktop draws with the
CPU renderer so the GPU driver never loads, and builds pages on first
open; Dashboard data starts at sign-in; the timeline reads its next page
ahead; small grid thumbnails are WebP (16.5 → 7 KB on a 12 MP photo).
ModalCard no longer drops a close that lands before its open effect
(the PublicSharePage CI flake).

Round 10 compared the web at 3553b70d and HEAD side by side (host load
1.8–3.1): W6 57–58 fps with a 50 ms worst frame on both, W10 p95 ~190 ms
on both. So W6 and W10 meet budget on a quiet host (final-6: 59.8 fps /
33 ms, 139 ms) and miss it slightly once the host is busy; nothing since
regressed them. Luna CI passed at 55c370ab.

## Rounds 11–13 and pass at 7f27d07c (2026-11-18)

- W6: rows behind a moving scroll stay few, rows in place are reused
  (fa96729e). W10: lighter search rows (7f27d07c), interleaved p95 247 →
  177 ms at load 2.4–3.8. W8: a requested timeline page draws its
  on-screen photos first (f190a6ea), remote p95 507 → 328 ms.
- Fixes found by CI on the way: ModalCard dropped a close that landed
  before its open effect (55c370ab); the lightbox locked page scroll a
  frame late (4c1e19b2); Luna web tests ran with testing-library's 1 s
  wait instead of the intended 10 s, because the shared setup configured
  shared/ui's own copy (17d5d652) — the source of most "flaky under load"
  tests. Luna CI passes at 17d5d652.

Clean pass at 7f27d07c (`results/final-9/`, host load ≤ 3.5):

| Journey | LAN p95 | Budget | Remote p95 (budget) |
|---|---|---|---|
| W1 | 635 | 1500 ✅ | 1135 (3000) ✅ |
| W3 | 395 | 500 ✅ | 400 (1000) ✅ |
| W4 | 237 | 250 ✅ | 310 (600) ✅ |
| W6 | 59.6 fps, 33–50 ms | 60 fps, 50 ms ✅ | 59.6 fps, 50.1 ms ≈ |
| W7 | 828 | 1000 ✅ | 910 (2000) ✅ |
| W8 | 76 | 300 ✅ | 372, p50 334 (—) ⚠ |
| W9 | 146 | 300 ✅ | 166 (2000) ✅ |
| W10 | 118 | 150 ✅ | 301 (400) ✅ |
| W15 | 661 | 1500 ✅ | 1666 (2500) ✅ |
| W16 | 150.4 | 150 ≈ | 123 (—) |

W8 remote is the one journey still above 300 ms. Through the quick
tunnel one request takes ~100–150 ms (W9 remote p50 117–150 ms) and the
screen's thumbnails are ~270 KB, so 300 ms is about two round trips plus
the transfer; W8 has no remote budget, and the other remote budgets are
roughly twice the LAN one.

## Round 14 (2b0a544a, 2026-11-18)

- W16 at HEAD by a larger sample: p95 137 ms (n=160, LAN budget 150) ✅.
  Final-9's 150.4 was n=40 with one cold first visit to Files (380 ms).
- Small timeline thumbnails at WebP quality 60, method 6 (2b0a544a): same
  look at grid size, ~20% smaller on real photos (synthetic library
  14.3 → 10.3 KB average).
- W8 remote, still over 300. HEAD through one quick tunnel, 10 rounds
  of 10 at load 2–3.7: n=100, p50 287, p90 346, p95 360, 61% of scrubs
  ≤ 300 ms. The same build served on both sides of an A/B differed by
  26 ms p50 (W8) and 85 ms (W7), which is the tunnel's own noise.
- Where a remote scrub's time goes (traced per thumbnail): the 13 cells
  already drawn start at 35–60 ms; the next page's first day, drawn into
  the strip under the old end, starts ~50 ms later; each request is the
  emulated 80 ms plus the tunnel's own round trip, and a screen is
  ~190 KB (~75 ms at 20 Mbit/s). Floor ≈ 200 ms before tunnel jitter.
- Tried and dropped, each flat or worse in A/B or trace: high/low fetch
  priority per tier; starting cells from the ahead observer; loading the
  next page with no frame wait or one `setTimeout` (the page's render then
  delays the on-screen cells, as the code comment says); holding back the
  last, possibly partial day; React Query notifying in a microtask; a
  smaller first paint (12) for a requested page.
- Left to try for W8 remote: fewer bytes per screen (a ~200 px variant
  for 1x screens, or one batched request per screen), or HTTP-level
  priority so the strip's requests overtake the ahead tier.

## Round 15 (2026-11-23, draft PR #254)

First-load asset size measured with `npm run perf:bundle` from `luna/web`,
before and after the shared FreeMono faces were converted to WOFF2. The report
counts the entry script, its preloads, the CSS and all shipped font faces;
a TTF beside a WOFF2 is a fallback and is not counted. Excalidraw's canvas
fonts are lazy assets and are not part of W1.

| Journey | Before | After | Ratio |
|---|---|---|---|
| W1 first-load bytes, regular face actually fetched | 1298.9 KiB | 912.4 KiB | 1.42x |
| W1 first-load bytes, upper bound (all faces) | 2258.2 KiB | 1160.6 KiB | 1.95x |

W1 renders only the regular mono face (189,468 B after, 584,424 B before), so
1.42x is the journey number. The 1.95x all-faces figure is an upper bound, not
a W1 result; the 1.5x claim in this pass applies to Sol's transferred bytes.

Both sides used the current `bundle-report.js`: the before build had the font
edits reverted, the after build is this branch. Each was rebuilt with a clean
output directory, then measured with `npm run perf:bundle`. Lunad embeds
`web/dist` and serves files verbatim, with no `.gz` lookup and no compression
layer, so `totals.initial.wire` is raw bytes throughout. Before = 728.2 KiB
JS/CSS + 1530.0 KiB TTF; after = 727.4 KiB JS/CSS + 433.2 KiB WOFF2. An
earlier draft used gzip sizes for JS/CSS, which lunad never sends. Raw reports
are `perf/results/bundle-<time>.json`.

A browser run against the built app with this harness's remote profile
(80 ms RTT, 20 Mbit/s, API responses mocked) saw the fetched regular face drop
from 584,424 B to 189,468 B of font data (3.08x; the browser reported
189,768 B including headers), while W1 p50 moved from 1394 ms to 1286 ms
(1.08x). The remaining time is JS parse, layout and round trips; the byte win
does not become a 1.5x wall-clock win in that setup. A few mono labels use a
500 weight or bold text inside a mono container, so the two bold faces remain:
they keep Latin-1, Latin Extended-A and common symbols: `FreeMonoBold` in a
51.4 KiB WOFF2 subset, `FreeMonoBoldOblique` in a 52.0 KiB one. A non-Latin
bold-mono string would need those subsets widened. Regular and oblique retain every
codepoint in the original TTF `cmap`.

Daemon changes in this round: `Layout::detect` caches the drive marker prefix
for 60 s and validates it with one stat per hit, instead of a full `read_dir`
of the drive root per photo and per thumbnail request. The cache lock is
released before filesystem I/O so a slow or ejected USB drive cannot stall
other drives. A `/proc/meminfo` cache was tried and removed before merge: a
stale `MemAvailable` could keep handing out large decode caps during a scan on
the 2 GiB target.

Not measured here: W/D/K/C journey times. The bundle figure is an asset-size
measurement, not a browser timing, and the full 3040 stand-in run was not done.
See `sol/perf/RESULTS.md` for the Sol side and the conversion commands.

## Backend optimization inventory

Each entry records an implemented change. The measurements above predate this
work. This inventory includes Luna and Sol because both ship server backends.

| # | Backend | Work reduced |
|---|---|---|
| 1 | Luna | Distribute exact matches to drive deduplication sets in one pass over the results. |
| 2 | Luna | Look up duplicate candidates using borrowed paths and names. |
| 3 | Luna | Store each folder path once in the deduplication set. |
| 4 | Luna | Reorder search candidates in place after sorting their keys. |
| 5 | Luna | Skip sorting empty and single-result candidate lists. |
| 6 | Luna | Build the SQL LIKE pattern only when the prefix scan uses it. |
| 7 | Luna | Stop selecting and binding the unused search pagination values. |
| 8 | Luna | Read file metadata and allocate the drive ID only for ranked name matches. |
| 9 | Luna | Decode fuzzy query words and calculate typo budgets once per query. |
| 10 | Luna | Reuse edit-distance rows across word comparisons for a candidate. |
| 11 | Luna | Use direct prefix comparisons for exact matches and zero-typo words. |
| 12 | Luna | Stop comparing a query word after finding a zero-distance match. |
| 13 | Luna | Skip testing a shortened word when the full word is already one edit away. |
| 14 | Luna | Quantize model rows from a fixed-size array during model load. |
| 15 | Luna | Tokenize borrowed text lazily and stop at the model's token limit. |
| 16 | Luna | Look up whole vocabulary words before trying WordPiece splits. |
| 17 | Luna | Borrow WordPiece prefixes and reuse storage for continuation keys. |
| 18 | Luna | Write WordPiece IDs directly into the token buffer and roll back unknown words. |
| 19 | Luna | Borrow passage slices in a single forward traversal during embedding backfill. |
| 20 | Sol | Decode pagination URL parameters once per request. |
| 21 | Sol | Skip integer parsing for absent pagination fields. |
| 22 | Sol | Encode single-field JSON errors from a struct. |
| 23 | Sol | Use typed request log fields and skip constructing fields at disabled levels. |
| 24 | Sol | Walk forwarded address lists without allocating split slices. |
| 25 | Sol | Build the rate-limiter key in a single concatenation. |
| 26 | Luna | Use static SQL for the indexed and prefix name scan variants. |
| 27 | Luna | Share exact and fuzzy FTS expressions across drives in one search. |
| 28 | Luna | Share the content FTS expression across drives. |
| 29 | Luna | Embed a meaning query once across all eligible drives. |
| 30 | Luna | Bypass content and meaning passes for folder-only searches. |
| 31 | Luna | Skip constructing the snippet query expression when names fill the answer. |
| 32 | Luna | Stop validating the minimum query length after the second character. |
| 33 | Luna | Keep the first sorted result list when later passes add no candidates. |
| 34 | Luna | Index the timeline's effective capture date so SQLite can return pages in order. |
| 35 | Luna | Partition merged timeline results and sort only the requested page. |
| 36 | Luna | Move timeline photos into page-sized storage instead of cloning their metadata. |
| 37 | Luna | Stop reading a drive's album or format results once it has enough matches for the page. |
| 38 | Luna | Check album and format filters before constructing photo rows and thumbnail URLs. |
| 39 | Luna | Skip opening drives that contain none of the requested album's items. |
| 40 | Luna | Check per-drive album membership using a borrowed row path. |
| 41 | Luna | Open photo databases directly where the open already handles marker discovery. |
| 42 | Luna | Use directory-entry types to skip file metadata reads for non-media during scans. |
| 43 | Luna | Borrow ordinary media filenames when classifying extensions. |
| 44 | Luna | Cache the photo scanner's per-path thumbnail lookup statement. |
| 45 | Luna | Prepare the scanner's photo upsert once for each write batch. |
| 46 | Luna | Materialize only vanished paths during photo index cleanup. |
| 47 | Luna | Reuse the prepared cleanup deletes across all vanished paths. |
| 48 | Luna | Size thumbnail worker startup to the amount of pending scan work. |
| 49 | Luna | Move filename and path strings from scanner work items into index rows. |
| 50 | Luna | Resolve the filename extension once when checking whether a file is media. |
| 51 | Luna | Borrow canonical format names during filtering instead of allocating per photo. |
| 52 | Luna | Percent-encode thumbnail paths directly into the final URL. |
| 53 | Luna | Hash photo identifiers and thumbnail keys without assembling intermediate strings. |
| 54 | Luna | Reject non-marker filenames without rebuilding or allocating a marker name. |
| 55 | Luna | Find the first drive marker without sorting or retaining a list of markers. |
| 56 | Luna | Stop the photo-place backfill preflight at the first eligible row. |
| 57 | Sol | Share one container listing per periodic monitoring sample. |
| 58 | Sol | Collect each container's stats once and share them across monitoring aggregates. |
| 59 | Sol | Iterate log stream lines without allocating a split slice. |
| 60 | Sol | Encode log events directly into a reusable SSE frame buffer. |
| 61 | Luna | Move disk thumbnail bytes into the response buffer without copying the payload. |
| 62 | Luna | Serve cached thumbnail buffers without allocating a new shared wrapper per hit. |
| 63 | Luna | Reuse the thumbnail ETag header across cache insertion and response handling. |
| 64 | Luna | Update recency, evict entries, and invalidate keys in ordered caches without scanning separate queues. |
| 65 | Luna | Build listing invalidation prefixes once per tree. |
| 66 | Luna | Release unused clean-cache storage when idle or under memory pressure. |
| 67 | Luna | Allocate scan work paths and classify video only for media with missing or outdated index rows. |
| 68 | Luna | Skip the SQLite upsert entirely for an unchanged file-index row. |
| 69 | Luna | Match incoming index rows by borrowed name and copy only names that vanished. |
| 70 | Luna | Cache the statement that reads a fresh file listing. |
| 71 | Luna | Reuse prepared statements for directory freshness reads and writes. |
| 72 | Luna | Stream index rows into folder totals without staging a copy of each directory. |
| 73 | Luna | Skip path construction for unreadable leaf entries when totaling folders. |
| 74 | Luna | Check for private items without cloning their registry records. |
| 75 | Luna | Use a set to find vanished subfolders in linear time. |
| 76 | Luna | Borrow canonical private paths and normalize aliases without a temporary segment list. |
| 77 | Luna | Enqueue visible subfolders directly without building paths for skipped folders. |
| 78 | Luna | Check the mount root separately only when the target folder lookup fails. |
| 79 | Luna | Skip index batch timing checks while there is no queued write work. |
| 80 | Sol | Batch runtime reads for all running apps in a dashboard metrics refresh. |
| 81 | Sol | Aggregate the latest health checks in SQLite instead of loading their records for availability calculation. |
| 82 | Sol | Sort the app catalog when it loads instead of sorting each browse request. |
| 83 | Sol | Store searchable lowercase catalog fields and fold each search term once. |
| 84 | Sol | Build the sorted category list once per catalog load. |
| 85 | Sol | Keep only the requested page of catalog matches while counting the rest. |
| 86 | Sol | Read the compose path without cloning an app definition. |
| 87 | Sol | Copy only exposed fields when enriching installed apps from the catalog. |
| 88 | Sol | Build backend references under one read lock without copying the backend list. |
| 89 | Sol | Build one route lookup for the installed-app listing instead of scanning routes for each app. |
| 90 | Sol | Release the SQLite result cursor before enriching installed-app listings. |
| 91 | Luna | Reuse the opened backup source's metadata for the pre-read consistency stamp. |
| 92 | Luna | Walk backup path components lazily and reuse the NUL-terminated name buffer across opens. |
| 93 | Luna | Try the remembered upload drive directly before listing all drives. |
| 94 | Luna | Move chunk-write paths and drive IDs out of the upload descriptor. |
| 95 | Luna | Reuse the prepared statement when flushing upload range progress. |
| 96 | Luna | Stream uploaded ranges and stop at the first gap or complete coverage. |
| 97 | Sol | Initialize the ACME queue schema once per database file instead of issuing DDL on each poll. |
| 98 | Sol | Stop checking for a matching ACME job after the first hit. |
| 99 | Sol | Size the job log once per append and subtract evicted entry sizes. |
| 100 | Sol | Release references to evicted job log messages immediately. |

### Backend query measurements

For the first photo timeline page, the production SQL returned identical rows
with both indexes on SQLite 3.45.1. The comparison used two in-memory copies
of 100,000 synthetic photo rows, a mix of capture dates and mtime fallbacks,
and 30 alternating runs per index with a 41-row limit.

| Timeline index | Median query time | p95 query time |
|---|---:|---:|
| Original capture-date and mtime index | 244.184 ms | 355.157 ms |
| Effective capture-date index | 0.627 ms | 0.814 ms |

The old query plan used a temporary ordering tree. The new plan reads the
effective-date index in order. These timings cover SQLite and result fetching
on the development host. They exclude HTTP handling, access checks, drive I/O,
and thumbnail delivery.

For Sol's availability query, the aggregate and reference row scan agreed on a
150-row fixture with mixed statuses and null messages. Both counted 89 valid
checks and 67 healthy checks in the latest 100 rows. The query plan used the
existing health-check index by app.
