# Luna performance review

## What made the gallery note box lag

**The biggest cost is in Luna, not the gallery.** Every icon-only button in shared/ui keeps a hidden spinner mounted, and its 8 dots animate forever. That happens even while the spinner is invisible, wrapped in two `will-change-transform` layers:

- `shared/ui/components/ui/Button.jsx:249-268`: the icon branch always renders `<Spinner decorative …/>`, parked below a clip at `opacity-0`.
- `luna/web/src/index.css:718-722`: `.comet-spinner__dot { animation: comet-trail 720ms linear infinite; }`. Sol has the same rule at `sol/server/frontend/src/index.css:435+`.

On a file row, Share, Copy, Move, Rename, Delete and Properties are all spinner-carrying `iconSm` Buttons. Download uses `asChild`, so it has none. That is 6 buttons × 8 dots = **48 endless animations and 12 compositor layers per row**. The `files/thousands` window keeps about 40 rows mounted, so the page carries roughly 2,000 running animations and about 500 layers while idle.

The frame is same-origin, so every frame the gallery draws also pays the frame's animation and compositing cost. Typing feels it. This is Luna-wide and Sol-wide: a 10-file folder still runs about 480 of these animations.

**The gallery's own cost is real but second:**
- Each keystroke re-renders the whole Gallery, including about 354 scenario buttons and the fault panel.
- Each fake request causes 2 full re-renders.
- The 400 ms address poll is nearly free: React skips the update because the string is the same.

Both the app and the gallery run as dev builds, and the app also runs under `StrictMode` (`luna/web/src/main.jsx:19`). That inflates React render cost in this harness, but not CSS animation or compositing cost.

**How you can split the two in about 2 minutes:**
1. In DevTools, switch the console to the frame's context and run `document.getAnimations().filter(a => a.playState === "running").length` on an idle `files/thousands`. I expect about 2,000.
2. Click "Open on its own" and type in the app's own "Find in this folder" box. If that feels smooth too, the remaining lag is the gallery.
3. Record 5 s in the Performance panel while typing in the note box. React work shows up as "Function call" blocks; the animation and layer cost shows up as "Recalculate style" and "Layerize".

**Naming mismatch:** `/files/d1?path=Big` renders `luna/web/src/pages/FilePage.jsx`, not `FilesPage.jsx`. The job cards ("Moving…/Copying…") are in `FilePage.jsx:148-185`, so the file-operation-card revamp probably touches `FilePage.jsx`. `FilesPage.jsx` is the drives overview.

## Ranked findings

| # | Area | Impact | Evidence | Fix |
|---|---|---|---|---|
| 1 | Web, shared/ui | **High**, everywhere | `Button.jsx:249-268` always mounts the Spinner in a `will-change-transform` span. `index.css:718-722` runs an infinite animation on each dot. About 48 animations per file row. | Pause the dots while not loading. Add `will-change` only while loading. Brief A. |
| 2 | lunad | **High**: can freeze the whole daemon | `stat_entry_sync` takes `state.db.lock()` at `api/files.rs:870` and keeps it through the folder totals at `api/files.rs:922-954`: (a) `folder_totals_indexed` (`files/index.rs:177-210`), up to 20,000 directories with an `fs::metadata` and a `prepare` per directory and **no time limit**; (b) the fallback `folder_totals` walk (`files/mod.rs:709-737`), up to 60,000 entries or 2.5 s. **Amplifier:** only 2 async workers (`main.rs:20-22`), and several async handlers take the same std mutex directly: auth device-token write (`auth.rs:896`), `drives::list` (`api/drives.rs:131`), `drive_health` (`api/drives.rs:571`), `drive_summary` (`api/drives.rs:604`), gallery `status` (`api/gallery.rs:793`). Two of them waiting means no worker is left, so everything stops, including `/health` and the SPA. | Collect what needs the database under the lock, drop the lock, walk, and take the lock briefly per `include` call. Brief L1. |
| 3 | Gallery harness | Medium (dev only) | Typing in the note calls `setDrafts` (`Gallery.jsx:41-42`), which re-renders the whole tree, including the unmemoized scenario list (`Gallery.jsx:192-214`) and `FaultPanel`. `engine.js:170` and `engine.js:178` both call `emit()`, so each request fires twice. `snapshot()` (`engine.js:252-260`) returns new objects every time, so `setSnap` always re-renders. | Give the note box its own state component, memoize the list and the fault panel, emit once per request coalesced to one per frame, and cache the snapshot by version. Brief C. |
| 4 | Desktop to lunad | Medium: constant load on Luna | `status_page.rs:244` (1 s), `sync_page.rs:130` (2 s) and `backup_page.rs:77` (2 s) each call `luna_desktop::list_drives` over HTTP and rebuild the whole list. They run even when the window is hidden. Each request goes through device-token auth: a SELECT plus an UPDATE under the global lock (`auth.rs:880-905`, `db.rs:2450-2503`). | Skip ticks when the page is not mapped, and check drives at most every 30 s. Run the token write on a blocking thread. Briefs D and L2. |
| 5 | lunad `/drives/detected` | Medium, conditional | Polled every 5 s for Admins (`FilesPage.jsx:438-443`, `DashboardPage.jsx:71-76`). For any drive row that is not found by name, `reconcile_scan` (`drives/mod.rs:884-888`) calls `find_detected_by_marker` (`drives/mod.rs:989-1003`). For each **unmounted** detected device that does a brief read-only mount, a marker read and an unmount (`drives/mod.rs:1019-1043`), holding `look_lock`. The cache lasts one pass (`drives/mod.rs:865`). So with one unplugged drive plus a card reader or a not-yet-added stick, it mounts and unmounts every 5 s. | Keep marker ids across passes, keyed by `(name, diskseq)`. Brief L3. |
| 6 | Web file list | Medium | `useWindowVirtualizer` (`FileBrowser.jsx:455`) uses the library's default `useFlushSync: true` (installed `@tanstack/react-virtual` 3.14.13). Every scroll event synchronously re-renders the whole 2,000-line `FileBrowser`. On every render, the folder-header measure effect (`FileBrowser.jsx:746-781`) also tears down and rebuilds its ResizeObserver and a 50 ms timer, then forces a layout read. Its deps include JSX props (`folderActions`, `breadcrumbExtra`) that are new on every render. | Set `useFlushSync: false`, and drop the JSX deps. Brief B. |
| 7 | Web file list | Medium-low | Each change to the find-in-folder text filters **and** re-sorts all entries with `Intl.Collator` (`FileBrowser.jsx:435-443`). Sorting 5,000 entries costs about 60k collator compares per change. | Sort once per `(entries, sortKey)`, then filter the sorted list. Lowercase names once per listing. Brief B. |
| 8 | lunad SMART | Medium (power and noise) | `smartctl -H -A -i` runs on every `/drives/{id}/health` call with no cache and no `-n standby` (`drives/smart.rs:109-117`, `api/drives.rs:587`). Callers: the Files page drive cards (`FilesPage.jsx:356-361`), the Dashboard's "Needs you" checks (`useNeedsYou.js:75-80`), and the system check (`system_health.rs:1298`, 60 s cache, polled every 60 s while the Dashboard is open). That system check also writes a test file to every drive each run (`system_health.rs:~1285-1294`). Together these keep spinning disks awake. | Cache per device for 10 minutes, and add `-n standby` so a sleeping disk returns the last known result. Brief L4. The test-file write is a product decision, so no brief. |
| 9 | Desktop sync | Medium (grows with folder count) | `REMOTE_POLL_INTERVAL = 5 s` (`sync.rs:17`), but the comment at `sync.rs:161` says 30 s. Each pass lists every remote folder, one request each (`luna.rs:567-600`), and walks the whole local tree (`sync.rs:339-370`). Local changes already trigger a sync right away (`sync.rs:193-199`). | Set it to 30 s. Brief D. |
| 10 | Web file list | Low-medium (large selections) | Linear scans inside loops: the selection clean-up effect calls `entryPaths.includes` per selected path (`FileBrowser.jsx:520-531`), which is O(selected×entries); after select-all on 5,000, each refetch does about 25M compares. Also the deep-link check (`:565`), the trash toolbar's `entries.find` per selected (`:1652-1660`, every render while selected in trash), `shareTarget`'s `entries.find` (`:1083-1092`), and `indexOf`/`includes` in `toggleOne`, `moveSelection` and `revealRow`. | Memoized Set and Maps for these lookups. Brief B. |
| 11 | Web, Members only | Low-medium | `rowFileHref` is a new arrow on every explorer render for Members (`DriveFileExplorer.jsx:399-401`). That defeats the memo on `FileRow`, so every mounted row re-renders whenever the explorer does. | Wrap it in `useCallback`. Brief B. |
| 12 | lunad search | Low | `visible_hits` (`api/search.rs:120-170`) calls `caps_on_path_rows` per candidate, and that runs `drive_mount` → `get_drive` SQL each time (`auth.rs:1251-1259`). `private_flags` runs `drive_root` SQL per kept hit (`api/search.rs:103-114`). That is up to 1,500 candidates per drive (`files/search.rs:93`), all under the global lock. | Look up each drive's mount once per pass. Brief L5. |
| 13 | lunad trash listing | Low | `list_trash_view` takes the global lock at `api/files.rs:278`, then `trash_meta_map` opens the drive's SQLite file on USB (`files/mod.rs:1830-1832`). | Read trash metadata before taking the lock. Brief L1. |
| 14 | lunad summary | Low | `disk_space(&root)` (`statvfs`) runs on an async worker (`api/drives.rs:~671-675`). A hung drive blocks one of the only 2 workers. | Move it to `spawn_blocking`. Brief L2. |

**Checked and fine; no change needed:**
- Folder listing is well layered: RAM listing, then the index, then `read_dir` (`files/mod.rs:314-347`). The global lock only covers the drive lookup and caps stamping (`api/files.rs:393-435`).
- The system health check is cached for 60 s.
- Search runs its drive-index queries outside the lock.
- Upload progress is already throttled (`DriveFileExplorer.jsx:513-520`).
- React Query refreshes after changes are scoped sensibly; I found no invalidation storm.
- Web polling stops in background tabs (React Query default) and has sane intervals: 5 s for drive state, 60 s for summaries, 1 s for jobs only while a job is busy.
- Mobile: `StatusFragment` ticks every 1 s but reads memory only and stops in `onPause` (`StatusFragment.kt:17-35`). Photo backup is incremental by `DATE_ADDED`, every 6 h (`WorkScheduler.kt:32`, `PhotoBackupWorker.kt:95-119`).
- Connect: lunad polls every 300 s when steady and every 10 s when it needs a fast answer (`net/connect.rs:20-22,505-518`). Connect's web page refreshes devices every 30 s (`LunaPage.jsx:191-197`).
- Fake lunad: listings scale with node count and stat walks twice; that's fine at 5,000.

---

## Brief A (Sonnet): stop hidden button spinners from animating

**Owned files:** `shared/ui/components/ui/Button.jsx`, `shared/ui/components/ui/Spinner.jsx`, `shared/ui/components/ui/Button.test.jsx`. Touch nothing else. No CSS changes; both apps share this markup and CSS.

**Changes:**
1. `Spinner.jsx`: add an optional `paused` boolean prop (default `false`).
   - When it's true, give every `.comet-spinner__dot` span the inline style `animation: "none"`, merged with its existing `--comet-i` var.
   - The center cell stays as it is. Update the JSDoc param type and propTypes.
2. `Button.jsx`, icon-only branch (the `iconOnly ? (…)` block with the two absolutely-stacked spans):
   - Remove `will-change-transform` from both spans' fixed class strings. Add it back only while loading: `loading && "will-change-transform"` inside `cn(...)` on both spans. The transform transition still runs; the browser promotes the layer during the transition by itself.
   - Pass `paused={!loading}` to the `<Spinner decorative …>` there.
   - Keep the spinner **mounted** and keep every translate, opacity and `aria-hidden` class exactly as it is. The existing test at `Button.test.jsx:49-69` depends on the spinner being parked below the clip.
3. Leave the non-icon branch alone; it already renders the Spinner only while `loading`.
4. `Button.test.jsx`: add a test. An idle `size="iconSm"` Button's spinner dots all have `style.animation === "none"`. After a rerender with `loading`, they don't.

**Acceptance:**
- An idle `files/thousands` frame reports about 0 running animations from `document.getAnimations()`; it was about 2,000 before.
- The icon-to-spinner swap still slides when `loading` flips.
- Existing Button tests still hold by reading. No user-visible copy changes.

**Self-check (don't run tests):** `npm run typecheck` and `npm run scan:colors` in `luna/web`, and again in `sol/server/frontend` (it uses the same Button). `npm run typecheck` in `shared/ui`.

---

## Brief B (Sonnet): file list render cost (lands after the operation-card revamp)

**Owned files:** `luna/web/src/components/files/FileBrowser.jsx`, plus one small, intent-described change in `luna/web/src/components/files/DriveFileExplorer.jsx`. Do not touch `FilePage.jsx` or `FilesPage.jsx`. Everything here is described by intent: re-read the current file after the revamp and find the code by the names given.

**Changes:**
1. **Sort once, filter after.** In `FileBrowser`, the memo that produces `visibleEntries` currently filters by kind and name and then sorts with `compareEntries`. Split it:
   - `sortedEntries = useMemo(() => [...entries].sort((a, b) => compareEntries(a, b, sortKey)), [entries, sortKey])`.
   - `nameKeys = useMemo(() => new Map(entries.map((e) => [e, displayNameOf(e).toLowerCase()])), [entries])`.
   - `visibleEntries` = `sortedEntries` filtered by `kindFilter` and the deferred query, using `nameKeys.get(e)`. Filtering keeps the order, so the result is identical.
2. **Index lookups.** Add memoized structures:
   - `entryPathSet` (Set of `entryPaths`).
   - `entryByPath` (Map from full path to entry, using the same `fileRoot ? path : joinPath(path, e.name)` rule).
   - `visibleIndex` (Map from visible path to index).

   Replace these uses:
   - The selection clean-up effect (the `setInnerSelected((prev) => prev.filter(…entryPaths.includes(p)…))` one): use `entryPathSet.has`.
   - The deep-link `select=` effect's `entryPaths.includes(selectPath)`: use `entryPathSet.has`.
   - `shareTarget`'s `entries.find(...)`: use `entryByPath.get`.
   - The `renderSelectionActions?.(selectedPaths, selectedPaths.map((p) => entries.find(...)))` argument: use `entryByPath.get`.
   - `visiblePaths.indexOf(...)` in `toggleOne`, `moveSelection`, `selectedEntry`, `revealRow` and `onRowDragStart`: use `visibleIndex.get(p) ?? -1`.
   - `selectedPaths.includes(...)` in `toggleOne`, `moveSelection` and `onRowDragStart`: use `selectedSet.has`.
3. **Scroll re-renders.** Add `useFlushSync: false` to the `useWindowVirtualizer({...})` options. The installed 3.14.13 supports it. Keep `overscan` as it is.
4. **Folder-header measure effect.** This is the `useEffect` that sets up a ResizeObserver plus `window.setTimeout(remeasureFolderChrome, 50)`.
   - Remove `folderActions` and `breadcrumbExtra` from its dependency array. They are JSX and new on every render.
   - Keep the rest. The ResizeObserver on the container and the probe already catches width changes from those props.
   - Update the eslint-disable comment if the linter needs one.
5. **Members' row link function** (`DriveFileExplorer.jsx`): the `rowFileHref` value built from `memberRows` (via `memberFileHref`) must keep the same identity across renders. Wrap it in `useCallback`, keyed on `access.data` (or the derived member rows) and `fileHref`. Behaviour is unchanged.
6. **Stretch, only if 1-5 are clean:** none. Do not split `FileBrowser` into child components in this pass.

**Acceptance:**
- `files/thousands`:
  - Sorting by name, size or age gives the same order as before.
  - Typing in "Find in this folder" doesn't re-sort; check the React Profiler with the memo deps.
  - Select-all then Escape is instant.
  - Scrolling shows no blank rows at normal speed.
- `files/search-many` and trash scenarios behave the same.
- Members' rows don't re-render on unrelated explorer renders (React Profiler, "why did this render").

**Self-check:** `npm run typecheck` and `npm run scan:colors` in `luna/web`.

---

## Brief C (Sonnet): state gallery's own cost

**Owned files:** `luna/web/src/dev/gallery/Gallery.jsx`, `luna/web/src/dev/fake/engine.js`. Dev only; nothing ships.

**Changes:**
1. **`engine.js` `dispatch`:**
   - Delete the `emit()` call inside `try` just before the success `return`. The one in `finally` stays.
   - Make `emit` coalesce: set a `pending` flag and notify the listeners once in `requestAnimationFrame`, falling back to `setTimeout(…, 16)`.
   - Add a `version` counter that `emit` increments.
   - `control.snapshot()` returns the same cached object while `version` is unchanged.
   - Every control method that calls `emit()` keeps calling it.
2. **`Gallery.jsx`:**
   - Extract a `ResultBox` component: the note textarea plus the Passed, Problem, Skip, Fixed-retest buttons and the advance checkbox.
     - It owns `note` in local state, and the parent mounts it with `key={scenario.id}`.
     - It seeds from the draft or the saved note.
     - On each change it writes into a parent `draftsRef` (a ref, so no parent re-render).
     - It calls `onRecord(status, note)`.
     - The parent's `record` takes the note as an argument. The `p` shortcut passes `draftsRef.current[scenario.id] ?? results[scenario.id]?.note ?? ""`.
     - The `f` shortcut keeps focusing `#note-input`.
   - Extract a memoized `ScenarioList({ grouped, selectedId, results, onPick })`, with `pick` wrapped in `useCallback`. It uses setters only.
   - Wrap `FaultPanel` in `memo`, and make `control` a `useCallback`.
   - Leave the 400 ms address poll alone.

**Acceptance:**
- Typing in the note commits only `ResultBox` (React Profiler).
- One fake request causes at most one Gallery commit.
- The scenario list doesn't re-render on keystrokes or requests.
- All shortcuts and the auto-advance behave the same. Saved results keep the same shape (`results.js` untouched).

**Self-check:** `npm run typecheck` and `npm run scan:colors` in `luna/web`.

---

## Brief L1 (Haiku): don't hold the global database lock across drive IO

**Owned files:** `luna/crates/lunad/src/api/files.rs` (`stat_entry_sync`, `list_trash_view` only), `luna/crates/lunad/src/files/mod.rs` (`folder_totals` only), `luna/crates/lunad/src/files/index.rs` (`folder_totals_indexed` only).

**Rule:** permissions must give exactly the same answers as before. Do not change which checks run, only when the lock is held.

1. `files::folder_totals`: change it to take `drive: &DriveRow` instead of `conn: &rusqlite::Connection`. It used `conn` only for `drive_root(conn, drive_id)`. Update both callers in `stat_entry_sync`. Grep for other callers and fix them the same way.
2. `stat_entry_sync`: in the block that takes `let conn = state.db.lock()` (the "one lock for the request-context fields" comment):
   - Keep `trashed_from`, `writable`, `original_name`, `name` and `caps` computed there.
   - Before the `if stat.kind == "dir"` totals block, get the drive row with `files::drive_root(&conn, &id)`, keep it as an owned value, then `drop(conn)`.
   - Rewrite `include` so it takes the lock itself: `|p| in_trash || state.db.lock().map(|c| crate::auth::has_cap(&user, &c, &id, p, crate::access::CAP_VIEW)).unwrap_or(false)`.
   - Then run `open_drive_db(&drive)` → `folder_totals_indexed(...)` → fallback `folder_totals(&drive, ...)` with no global guard alive.
3. `folder_totals_indexed`: change `conn.prepare(` inside the loop to `conn.prepare_cached(`.
4. `list_trash_view`: call `files::trash_meta_map(std::path::Path::new(&drive.mount_point))` right after `drive_row(...)`, **before** `state.db.lock()`. Then remove the `drive_root(&conn, id)`/`root` lines that only fed it.

**Acceptance:**
- In both functions, no `state.db.lock()` guard is alive across `folder_totals*`, `open_drive_db` or `trash_meta_map`.
- JSON output is unchanged.

**Self-check:** from `luna/`, `cargo check -p lunad --tests`. Grep each function for `db.lock()` and confirm where each guard drops.

## Brief L2 (Haiku): keep blocking work off the 2 async workers

**Owned files:** `luna/crates/lunad/src/auth.rs` (the global auth guard's device-token branch), `luna/crates/lunad/src/api/drives.rs` (`drive_summary` only).

1. `auth.rs`: in the guard, the `if let Some(token_ctx) = device_token_ctx { … if let Ok(conn) = state.db.lock() { note_device_token_activity_rich(...) } }` block.
   - Move the lock and the call into `tokio::task::spawn_blocking(move || { … }).await`, ignoring the result.
   - Clone what it needs (`state`, `token_id`, `last_used_at`, `action`, `detail`, `client`, `origin`) into owned values first.
   - Keep it **awaited**, not fire-and-forget, so ordering and tests stay the same.
2. `drive_summary`: wrap `crate::drives::summary::disk_space(&root)` in `tokio::task::spawn_blocking(…).await`. Clone `root` in; on a join error, use `None`.

**Acceptance:** same responses and the same activity rows.

**Self-check:** `cargo check -p lunad --tests`.

## Brief L3 (Haiku): stop re-mounting the same stick every 5 s

**Owned files:** `luna/crates/lunad/src/drives/detect.rs`, `luna/crates/lunad/src/drives/mod.rs`.

1. `DetectedDrive`: add `pub diskseq: Option<u64>`. Fill it in the sysfs scan from `/sys/block/<name>/diskseq` (trimmed, parsed), and use `None` when the file is missing or for mock devices. Fix every constructor that `cargo check` flags (use `None`).
2. `DriveManager`: add a field `marker_memo: Mutex<HashMap<(String, u64), Vec<String>>>`, initialized empty.
3. `marker_ids_on_detected`: only in the **unmounted** branch (brief read-only mount), and only when `device.diskseq` is `Some(seq)`:
   - Return the memo value for `(name, seq)` if there is one.
   - Otherwise mount, read, store, return.
   - Mounted devices and `diskseq == None` behave exactly as today.
4. Start of `reconcile_scan`: drop memo entries whose `(name, diskseq)` is not in the current `detected` list.
5. Clear the whole memo inside every `DriveManager` method that adopts, inspects, peeks, writes a marker, ejects, releases or removes a drive. Grep for `mount_typed` and marker writes to find them.

**Stop and report** rather than guess if any of those paths are unclear.

**Acceptance:** with an unplugged drive row and an unmounted, not-yet-added stick present, repeated `/drives/detected` calls mount the stick once. Adoption, replug and rename flows are unchanged.

**Self-check:** `cargo check -p lunad --tests`.

## Brief L4 (Haiku): cache SMART results and let sleeping disks sleep

**Owned file:** `luna/crates/lunad/src/drives/smart.rs`.

1. Add a process-wide cache, `static CACHE: OnceLock<Mutex<HashMap<String, (Instant, DriveHealth)>>>`, keyed by device name. Derive `Clone` on `DriveHealth` if it's missing.
2. In `read(device)`, after the `applicable` check:
   - If there's a cache entry younger than 10 minutes, return it.
   - Otherwise run `smartctl` with `"-n", "standby"` added before `-H`.
   - When the result is not usable (`!smartctl_output_usable(code)`), which includes a skipped sleeping disk: return the cached entry if there is one (any age); otherwise return today's "unknown" value. Don't cache it.
   - On a usable result, store it and return it.

**Acceptance:**
- Two health reads in a row run `smartctl` once.
- A sleeping disk isn't woken, and returns its last known health.
- Field values are unchanged.

**Self-check:** `cargo check -p lunad --tests`.

## Brief L5 (Haiku): search, one drive lookup per pass

**Owned files:** `luna/crates/lunad/src/api/search.rs`, `luna/crates/lunad/src/auth.rs` (visibility change only).

1. `auth.rs`: change `fn caps_on_path_rows_at` to `pub(crate) fn`. No body change.
2. `visible_hits`:
   - Build `mounts: HashMap<String, Option<String>>`, filled lazily per `hit.drive_id` with the same rule as `drive_mount`: `get_drive`, filter out an empty `mount_point`.
   - Build `roots: HashMap<String, Option<PathBuf>>`, filled lazily from `crate::files::drive_root(conn, id)`.
   - Replace `caps_on_path_rows(...)` with `caps_on_path_rows_at(user, conn, &hit.drive_id, &full, &grants, mounts[..].as_deref())`.
   - Change `private_flags` to take the cached root instead of looking it up.

**Acceptance:** identical hits and flags.

**Self-check:** `cargo check -p lunad --tests`.

## Brief D (Haiku): desktop polling

**Owned files:** `luna/desktop/src/ui/status_page.rs`, `luna/desktop/src/ui/sync_page.rs`, `luna/desktop/src/ui/backup_page.rs`, `luna/desktop/src/sync.rs`.

1. In each page's `glib::timeout_add_local` tick:
   - Return `glib::ControlFlow::Continue` without refreshing when the page's root widget `!is_mapped()`. Hidden window or another stack page means not mapped.
   - Also refresh once when the root is mapped again: `connect_map` calls `do_refresh()`.
2. In each page's `do_refresh`, only call `luna_desktop::list_drives(&state)` (the "no drives" check) if 30 s have passed since the last check.
   - Keep `Rc<Cell<Option<Instant>>>` and `Rc<Cell<bool>>` on the main thread.
   - Pass a `check_drives: bool` into the blocking closure, and reuse the stored value when it's false.
   - In-memory progress still refreshes on every tick.
3. `sync.rs`: `REMOTE_POLL_INTERVAL` goes from 5 s to 30 s, which matches the existing "every 30s" comment. Leave the local-change trigger as it is.

**Acceptance:**
- With the window hidden, the desktop makes no periodic requests apart from the sync loop.
- With it visible, it makes at most one `/api/v1/drives` request every 30 s per page.
- No copy changes.

**Self-check:** `cargo check --manifest-path luna/desktop/Cargo.toml --tests`. Desktop is its own workspace (excluded in `luna/Cargo.toml`) and needs GTK 4 and libadwaita dev packages.

No changes for mobile or Connect.

---

### Critical files for implementation
- /home/plainskill/Projects/LibreServ/shared/ui/components/ui/Button.jsx
- /home/plainskill/Projects/LibreServ/luna/web/src/components/files/FileBrowser.jsx
- /home/plainskill/Projects/LibreServ/luna/web/src/dev/gallery/Gallery.jsx
- /home/plainskill/Projects/LibreServ/luna/crates/lunad/src/api/files.rs
- /home/plainskill/Projects/LibreServ/luna/desktop/src/ui/status_page.rs