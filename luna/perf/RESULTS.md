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
