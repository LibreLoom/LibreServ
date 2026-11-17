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

Pending: one clean whole-suite pass at HEAD on a quiet machine
(`scratchpad final3.sh`: bench + web journeys LAN and remote against the
running luna-3040).
