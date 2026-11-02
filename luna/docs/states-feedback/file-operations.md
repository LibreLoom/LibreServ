# File operation card (stream A)

Status: shipped 24 Oct 2026 (`d7e36bf7` … `7ed6b535`); `ed629e48` moved copy/move into the dock. §1 ("today") describes the pre-dock code and stays as history; §2, including the strings in §2.11 that `lib/fileOps/` implements, is live documentation.

Source: `plan.md` §5 stream A, plus the Max decision of 23 Oct 2026: *"the file operation card covers any file operation with length and is per-tab."* Gallery notes: `files/upload-*`, `files/copy-*`, `files/move-fails-partway`.

**Preconditions (phase 1, not re-planned here):**
- **1.6:** the fake applies jobs all at once, like `jobs.rs`.
- **1.7:** a real XHR shim, so the fake streams progress during the wait (`upload-slow` a).

If 1.7 hasn't landed, `upload-slow` (a) stays open after this stream.

---

## 1. Inventory: file operations in `luna/web` today

| # | Operation | Started by (file → function) | Wire | Progress today | Errors today | Completion today | In the card? |
|---|---|---|---|---|---|---|---|
| 1 | Upload in the explorer (drive) | `components/files/DriveFileExplorer.jsx` → `uploadFiles` → `lib/fileSource.jsx` `driveSource.uploadFile` | ≤ 32 MB: `postFormProgress` → `POST /api/v1/drives/{id}/files/upload` (multipart). > 32 MB: `POST /api/v1/uploads`, then 8 MB `putBinaryProgress` chunks via `sendChunkWithRetry` (about 2 min of retries on 0/408/429/502/503/504), then `POST /api/v1/uploads/{id}/complete` | XHR progress, max 10 updates/s, kept in the explorer's own `useState` and drawn by `UploadProgressList`. **Lost when the explorer unmounts.** The upload loop keeps running unseen, and its toast still fires (what Max saw in `upload-slow`). | Only the first error per batch goes to `setActionError` → `useStrandedErrorToast` → error toast. The rest are dropped. A name clash is just an error (`409`, no `code`). On any error the chunked path calls `DELETE /api/v1/uploads/{id}`. | Row removed; one success toast per batch (`"N files uploaded."`). Each call to `uploadFiles` runs its own `mapPool(…, 2)`, so two drops mean 4 uploads at once. | **Yes**, always |
| 2 | Drop / pick files | `components/files/FileBrowser.jsx` → `handleOsDrop`, `onFolderDrop`, the hidden `<input type="file" multiple>` at the Upload button, the `u` shortcut. `components/files/UploadFilesPanel.jsx` for folders where the person can upload but not view. Both use `lib/collectUploadFiles.js` `filesFromDataTransfer` | n/a | n/a | `readEntry` uses `Promise.all`, so **one unreadable entry rejects the whole drop**. Empty folders are dropped. **There's no folder picker** (no `webkitdirectory`). | n/a | **Yes** (input side) |
| 3 | Upload on a share link | `pages/PublicSharePage.jsx` → `uploadOne` + its own batch loop → `shareSource.uploadFile` → `uploadBlob` (`/s/{token}/upload…`, chunked) | chunked | A second copy of the upload state, drawn with the imported `UploadProgressList` | `uploadError` PageNotice, first error only | Toast | **Yes** |
| 4 | Gallery upload | `pages/GalleryPage.jsx` → `uploadFiles` mutation | One `postForm` after another into `Photos` on the first writable drive | **None** | `setError` banner. **Stops at the first failure**, so a clash ends the batch. | Toast, invalidates gallery, then `rescan` | **Yes** |
| 5 | Copy / move from the picker | `DriveFileExplorer.jsx` → `transferMutation` → `submitBatch` → `POST /api/v1/jobs` once per path | Jobs | `pages/FilePage.jsx` polls `GET /api/v1/jobs` every 1 s while any job is `running`/`queued` and draws `activeJobs` cards with Cancel (`DELETE /api/v1/jobs/{id}`). For admins this list is **everyone's** jobs. | Enqueue errors → `actionError`. **A job that ends in `error` or `interrupted` is filtered out by `jobBusy` and vanishes: the silent swallow** (`copy-fails-drive-full`, `move-fails-partway`). `409` clash has no `code`. lunad allows `MAX_QUEUED_PER_USER = 4` running jobs, so **the 5th path answers `503` and the rest are never sent**. | Toast **at enqueue** (`"Luna is copying those files."`), which counts as progress under the AGENTS toast rules. `prevBusyJobIds` effect invalidates lists. No completion toast. | **Yes** |
| 6 | Drag to move (rows, crumbs, header drive menu) | `hooks/useDriveMove.js` (used by `FileBrowser` drops and the `DriveMenu` drop in `FilePage.jsx`) | Jobs | Same as 5 | Same as 5. `broadens_access` → `ConfirmModal` (in both `DriveFileExplorer` and `FilePage`) | Enqueue toast | **Yes** |
| 7 | Move to Trash | `DriveFileExplorer.jsx` → `removeMutation` (one `source.remove` after another) | `DELETE /api/v1/drives/{id}/files?path=` → `files::delete_to_trash`: a same-drive `rename_noreplace`, **instant even for huge folders** | None | Stops at the first failure → `actionError` | Toast | **Only for batches.** A long multi-select is noticeable; one item is not. Goes through the 600 ms rule (§2.6). |
| 8 | Restore from Trash | `DriveFileExplorer.jsx` → `restoreMutation` (`submitBatch` → `POST …/files/restore`) | Rename, instant | None | First failure; a clash goes to the restore-name modal | Toast | Batches only (600 ms rule). The single-item modal flow stays. |
| 9 | Delete permanently | `DriveFileExplorer.jsx` → `purgeMutation` (one `POST …/files/purge` after another) | `remove_dir_all` in `spawn_blocking`: **slow for big folders** | None | First failure | Toast | **Yes** |
| 10 | Empty Trash | `DriveFileExplorer.jsx` → `emptyTrashMutation` → `POST …/files/purge {path: ".luna-trash"}` | One long blocking request | Button spinner in the ConfirmModal | `actionError` | Toast | **Yes** |
| 11 | Restore a folder/file from a drive backup (row action) | `components/files/backupsView.jsx` → `BackupRowActions` `restore` mutation → `POST /api/v1/drives/{id}/backups/{bid}/restore` | `copy_tree` in `spawn_blocking`, no progress | Button `loading` | Error toast | Toast | **Yes** |
| 12 | Restore a file version from a backup | `backupsView.jsx` → `VersionsModal` `restore` | Same endpoint | Button `loading` in the modal | PageNotice in the modal | Toast `"Restored as …"` | No. The open modal owns it (AGENTS toast rules). |
| 13 | Folder download (zip) | `<a href={source.downloadHref(…)}>` in `DriveFileExplorer.jsx` `DownloadButton`, `FileRow.jsx`, `FileBrowser.jsx` (`d` shortcut, selection bar) | `GET …/files/content?download=1` → `serve_folder_zip` **builds the whole zip into a temp file before it sends headers** | **None.** The click seems to do nothing for a while. | An error such as `"That folder has too many files…"` arrives as a JSON body that the browser downloads or shows | Browser download bar | **Yes**, last and deferrable (R2 + F8) |
| 14 | Gallery "download selected" | `GalleryPage.jsx` → `downloadSelected` → `POST /api/v1/gallery/download` → `res.blob()` | The whole zip goes **into memory** | None | Silently falls back to one link per photo | n/a | Not in this stream. Logged as follow-up (needs the same prepare step as 13). |
| 15 | Editor saves, form pictures, office sessions | `saveFile`, `uploadFormPicture`, … | n/a | Editors own their save state | n/a | n/a | No |
| 16 | Cloud restore / private restore | `CloudRestoreCard.jsx`, `PrivateRestoreCard.jsx` | n/a | Their own stateful cards | n/a | n/a | No. Settings and recovery flows, not file explorer work. |

### Facts from lunad that the design relies on

- Job states are `running`, `done`, `error`, `cancelled`, `interrupted`. `insert_job` writes `'running'` straight away, so **`queued` never exists** on the real server. The fake's `failed` is drift.
- When a copy, or a cross-drive move, fails or is cancelled during the copy phase, `jobs.rs` removes the partial destination (`owned_dest`), and the **source is untouched**. A same-drive move is one rename and can't fail partway.
  - One exception: in a cross-drive move, if moving the originals to Trash fails after the copy, both copies remain.
  - On every end state, `update_job_progress(total, total)` runs, so **a failed job reports 100%**. R1 fixes this.
- A job name clash is refused **at enqueue** (`JobError::Conflict` → `409`, no `code`). It is checked only on the top-level name, so it is a whole-file or whole-folder clash.
- An upload name clash is found only at `/complete`. `POST /api/v1/uploads` doesn't check names. `complete()` doesn't change the session state on a clash, so the session stays usable: the client can call `/complete?overwrite=1` again with no re-upload.
- `uploads::complete` already has `rename_on_conflict` (`find_free_name` → `name (1).ext`), but only share drop boxes use it.
- Upload folders are created on demand (`dest_dir_create`), so lunad accepts nested paths for folder uploads. The fake rejects them (`needFolder`).
- `sweep_orphans` removes upload sessions idle for 24 h (`ORPHAN_IDLE_SECS`).
- Empty trash, permanent delete and backup restore run in `spawn_blocking` holding their guard. They **finish even if the tab goes away**.

---

## 2. Design

### 2.1 Store: in memory, one per tab

- `createFileOpsStore({ queryClient, addToast, haptic })` is a factory: plain JS plus `subscribe`/`getState`. It is not a module singleton, so tests get a fresh store.
- `FileOpsProvider` (in `src/context/FileOpsContext.jsx`) creates one store per mount and injects `useQueryClient()` and `useToast().addToast`.
- It mounts in `App.jsx` **above `<Routes>`**: inside `QueryClientProvider` > `BrowserRouter` > `ToastProvider`, and around `ShortcutsProvider`/`AuthProvider`. That way `/s/:token` (outside `AppShell`) shares it, and route changes never unmount it.
- Hooks:
  - `useFileOps()` returns the actions.
  - `useFileOpsState(selector)` reads state through `useSyncExternalStore`.
- Notifications are throttled: at most one emit every 100 ms for progress, and immediate on state changes.
- **No `localStorage` / `sessionStorage`.** A new tab gets an empty store.
- Each operation carries its own context from when it started: the `FileSource` object, `driveId`, destination folder and labels. Invalidation and retries never depend on the component that started it still being mounted. Callbacks passed in must not call component `setState`.

**What a reload or tab close does:**

| Work | On reload / close |
|---|---|
| Browser uploads (multipart or chunked) | The XHRs abort. The file bytes are gone, so they can't resume. Multipart: lunad drops the partial body. Chunked: on `pagehide` the provider sends `fetch(DELETE /api/v1/uploads/{id}, { keepalive: true, headers: withCsrfHeaders("DELETE") })` for each open session (share: `/s/{token}/upload/{id}` plus the password header). Whatever is left, `sweep_orphans` removes after 24 h idle. |
| Name-clash decisions not yet answered, folder walks still going | Lost |
| Client-driven batches (trash / restore / purge loops, job submissions not yet accepted) | Stop at the request in flight. Later items are never sent. |
| Accepted copy/move jobs | **Keep running on Luna and finish.** The new page's card doesn't show them (per-tab). Results show in the file lists. |
| Empty trash, permanent delete, backup restore already sent | Finish on Luna. The result isn't shown. |

### 2.2 Where the card mounts

- `FileOpsDock` renders once inside `AppShell` (after `<PageOutlet />`, before `<Navbar />`), and once inside `PublicSharePage`. It shows on every in-app page while it has rows, so it survives navigation within the tab.
- Placement:
  - Desktop (`xl:`): `fixed right-6 bottom-28 w-[400px]`. The desktop navbar is `fixed bottom-6 … min-w-screen`, about 64 px tall, so `bottom-28` clears it.
  - Mobile: `fixed inset-x-3 bottom-24` (clears the 60 px FAB at `bottom-5 right-5`).
  - `z-40` (under modals `z-50`, toaster `z-[9999]`).
  - Max height `max-h-[60vh]` with internal scroll.
- Collapsed: one header line. It starts collapsed on mobile and expanded on desktop. It opens itself the first time a row gets a problem.
- `role="region" aria-label="File tasks"`. `aria-live="polite"` goes only on each operation's status line (state changes), never on the percent.

### 2.3 Row model

```js
/** @typedef {"upload"|"copy"|"move"|"trash"|"restore-trash"|"purge"|"empty-trash"|"restore-backup"|"zip"} OpKind */
Op = {
  id, kind, createdAt, endedAt,
  source,               // FileSource captured at start (drive or share)
  driveId, destDriveId, destFolder, destLabel, title,   // title = the name shown in the pill
  state: "preparing"|"running"|"waiting"|"done"|"partial"|"failed"|"cancelled",
  walking: boolean,     // folder walk still finding files
  bytesDone, bytesTotal, itemsDone, itemsTotal,         // null total = indeterminate
  policy: null | "replace"|"keep_both"|"skip",          // set by "… for all"
  items: Item[],
  error: string|null,   // op-level (e.g. "Choose one file to replace this file.")
  successToast: string|null,
}
Item = {
  id, name, relPath, destPath, size, received,
  state: "queued"|"uploading"|"finishing"|"submitting"|"running"|"done"|"skipped"
       |"needs-decision"|"failed"|"cancelled",
  error: string|null, retryable: boolean,
  decision: null | {
    type: "exists", existingKind: "file"|"dir",
    options: Array<"replace"|"keep_both"|"skip">,
  } | { type: "broadens", message: string, options: ["confirm","skip"] },
  file?: File, uploadId?: string, jobId?: string, abort?: AbortController,
  completeOnly?: boolean,   // chunked upload whose bytes are all on Luna; a decision just re-calls /complete
}
```

- **Problems** are items in `needs-decision` or `failed`.
- **State of the whole operation:** `done` when every item is done or skipped. `partial` when it has finished and some items failed. `failed` when it has finished and no item is done.
- **Visibility (the 600 ms rule):** every file operation registers in the store. An operation appears in the dock if it is still running 600 ms after it started, or ends with a problem.
  - Uploads and copy/move always appear immediately.
  - A quick single trash/restore never shows in the dock and only gets its toast.
- **Auto-clear:** an operation that finishes with no problems leaves the dock 4 s after it finishes. Its toast already said so. Operations with problems stay until cleared or resolved. The dock hides when it is empty.

### 2.4 Running uploads

- **One global upload pool:** `UPLOAD_PARALLEL = 3` across all operations in the tab. A chunked upload uses one slot.
- **Folder walk streams.** The walk runs while uploads run. The operation shows `Counting files… 340 found` until the walk ends, then the totals are final.
- **Name check before upload (cheap):**
  - For each distinct `destPath` in an operation, call `source.listDir(driveId, destPath)` once and cache the name set.
  - For nested folders, list only if the parent's listing holds a folder with that name. Otherwise treat it as new and empty: no request.
  - Any error means "unknown, no early clash". The server's `409 exists` is the safety net.
  - Share upload-only links return `[]`, which is right: lunad renames on drop boxes.
- **A clash** (early, or `409` with `code: "exists"`):
  - The item goes to `needs-decision`, leaves the pool, and the others keep going.
  - If `op.policy` is set, it applies at once and no row appears.
  - A chunked clash at `/complete` sets `completeOnly`, keeps the session and does **not** call `DELETE`. The decision re-calls `/complete?overwrite=1` or `?keep_both=1`.
  - A multipart clash re-sends with `&overwrite=1` / `&keep_both=1` (it's at most 32 MB).
  - Options:
    - Existing file: `replace`, `keep_both`, `skip`.
    - Existing folder: `keep_both`, `skip`.
    - Single-file share links (`source.isFile`): never a decision. The server replaces.
- **Network loss:**
  - While `sendChunkWithRetry` is retrying, the item line reads `Connection lost. Trying again…`.
  - After the retries run out, or when a multipart upload hits status `0`: `failed`, retryable.
  - One `window` `online` event retries every retryable status-0 item once.
- **401:** `failed`, retryable, with the error from `apiErrorMessage`. Sign-in shows in place, and the store is above it, so rows survive. Retry works after signing in.
- **Empty folders:** call `source.mkdir(driveId, path)`. An "already exists" error counts as success.
- **Unreadable local entries** (the walker's `readEntries`/`file()` error callback): `failed`, not retryable, `Your browser couldn't read this file from your device.`
- **Invalidation:**
  - `fileListKey(op.source, op.driveId, folder)` for each touched folder, at most once a second per folder while running and once at the end.
  - Plus `["recents"]`.
  - Gallery operations pass `invalidateKeys: [["gallery"], ["gallery-status"]]` and `afterFinish: () => postJson(<rescan>)`.

### 2.5 Running copy/move jobs

- **Client queue:** at most 4 accepted jobs running for this tab (`MAX_QUEUED_PER_USER`). The next item is sent when one finishes.
  - `503` with `code: "queue_full"` (R1) → item `submitting` with the line `Waiting for Luna to finish other copies…`.
  - Retry after the next own job ends, or after 5 s.
- **Polling:** `GET /api/v1/jobs?limit=200` every 1 s while any own job is `running`, **filtered to this tab's job ids**. If an id is missing, fall back to `GET /api/v1/jobs/{id}`.
  - `done` → item done, invalidate `["files", from]`, `["files", to]`, `["trash", from]`, `["trash", to]` and `["jobs"]` (the same keys `prevBusyJobIds` uses today).
  - `error` / `interrupted` → `failed`, with lunad's `error` text. It is never dropped.
  - `cancelled` → `cancelled`.
- **Clash at enqueue** (`409 code: "exists"`, plus `existing_kind` from R1):
  - **Keep both:** submit again with `on_conflict: "keep_both"`. lunad picks `name (1)`.
  - **Replace** (only when `existing_kind === "file"` and it isn't a same-folder copy):
    1. The client moves the existing item to Trash: `source.remove(toDrive, joinPath(toPath, name))`.
    2. It submits again with no `on_conflict`.
    3. If step 1 fails, the item is `failed` with that error.
  - **Skip:** the item ends as `skipped`.
  - Lunad never replaces a folder silently.
  - A copy into its own folder offers Keep both / Skip only.
- **`broadens_access`** (409): becomes a row decision. Options: `confirm` (submit again with `confirm_broaden: true`) or `skip`. This replaces both `ConfirmModal`s.
- **Cancel:** `DELETE /api/v1/jobs/{id}` for each own running job in the operation, plus dropping any items not yet sent.

### 2.6 One-shot and batch requests

`store.startRequest({ kind, title, destLabel, items:[{name, run}] | run, successToast, invalidateKeys })`.

- Runs items one after another and **continues past failures**.
- With no item count it shows `LinearProgress` (indeterminate) from `@libreloom/ui/components/common/LinearProgress.jsx`, with `surface` matching the row.
- Used for:
  - Empty trash
  - Delete permanently (one or many)
  - Move to Trash for more than one item
  - Restore from Trash for more than one item
  - Backup row restore
- Single trash and restore stay as they are.
- Confirm modals now close on confirm and hand the work to the store. The error shows in its row, not in the modal and not as a toast.

### 2.7 "N more problems →"

- Each operation row shows **at most one** problem inline, the oldest, with its buttons.
- Below it, a `Button variant="ghost" size="sm"` labelled `1 more problem →` / `14 more problems →`. It opens `FileOpProblemsModal`, a `ModalCard` titled for that operation, which lists every problem in that operation with its own buttons.
- Bulk buttons in the modal footer, shown only when they apply:
  - `Replace all`, `Keep both for all`, `Skip all` (name clashes). These set `op.policy`, so clashes found later in the same operation follow them. The footer note says so.
  - `Try all again` (retryable failures)
  - `Clear failed`
- Nothing else in the operation pauses while the modal is open.

### 2.8 Folder upload

- **Drop:** inside the `drop` event, call `takeDropped(dataTransfer)` synchronously. It returns `{ entries: FileSystemEntry[], files: File[] }`. `webkitGetAsEntry` only works during the event. The walk itself runs later, inside the store.
- **Pick:** the FileBrowser `Upload` button becomes a `Dropdown` (`@libreloom/ui/components/common/Dropdown.jsx`) with two items:
  - `Upload files`: the existing `u` shortcut.
  - `Upload a folder`: a new `useShortcut("shift+u", …, { label: "Upload a folder", group: "Files" })`, using a hidden `<input type="file" webkitdirectory multiple>`.
  - The folder item is hidden when `"webkitdirectory" in document.createElement("input")` is false.
  - `UploadFilesPanel` gets the same two buttons: `Choose files`, `Choose a folder`.
- **Walker** (`walkDropped(dropped, { onFile, onDir, onError })`):
  - It's an async loop over `readEntries` batches. Each entry has its own try/catch, so one bad entry never stops the walk.
  - It reports empty folders through `onDir`.
  - For picker input it uses `file.webkitRelativePath`.
- **Problem folders:** a bad file becomes a failed row. Every other file continues.
- **A file in the way:** if a file sits where a folder should go, every file under it gets lunad's `That destination is not a folder.` These are grouped through "N more problems →".
- **Junk files:** no silent skipping of OS junk files. If lunad refuses a name, its message shows in the row.

### 2.9 Toasts, haptics, errors

- **Errors from the card never go through `actionError` / `useStrandedErrorToast`, and never toast.** They live in their row.
- **One success toast per finished operation**, counting only what succeeded. No toast when nothing succeeded. The **enqueue toasts are removed** (`"Luna is copying those files."`, `"Luna is moving that file."`, `"Luna is moving N items."`).
- **Haptics:**
  - Buttons, Dropdown and ModalCard own their haptics.
  - The store fires `haptic("warning")` the first time an operation gets a decision.
  - It fires `haptic("error")` the first time an operation gets a failure.
  - It fires these at most once per operation per 2 s, never per item.
  - Expand/collapse in the dock header: `haptic("light")`.
  - Drops keep `haptic("heavy")` (already in FileBrowser).
- **`beforeunload` guard** (in the provider): `preventDefault()` plus `returnValue = ""` while `store.hasBrowserWork()` is true. That means any of:
  - an upload queued, uploading or finishing
  - a decision waiting on an upload
  - a folder walk still running
  - a client batch still sending
  - a job item not yet accepted by Luna

  There is **no guard for jobs Luna has accepted or blocking requests already sent**: leaving doesn't stop them, so a warning would be untrue. Browsers show their own text.

### 2.10 Visual (Simplex Mono)

- **Dock:** `Card` (`surface-secondary`) from `@libreloom/ui/components/cards/Card.jsx`, `padding={false}`, no extra border or ring.
- **Operation rows:** `rounded-large-element surface-primary p-3` inside the card.
  - Buttons on rows use `surface="primary"` for `outline`/`ghost`.
  - Buttons on the card header use `surface="secondary"`.
- **Progress bar:**
  - On a `surface-primary` row: track `h-1.5 rounded-pill surface-secondary p-px overflow-hidden`, fill `h-full rounded-pill surface-primary motion-safe:transition-[width] motion-safe:duration-300`.
  - Inside an item line on a `surface-secondary` panel: the inverse.
  - `role="progressbar"` with `aria-valuenow` / `aria-valuemin` / `aria-valuemax` and `aria-label`.
- **Problem lines:** `rounded-large-element border bg-error/20 border-error/30` (failed) or `bg-warning/20 border-warning/30` (decision). Text keeps the row's surface color. Only the icon (`AlertTriangle` / `CircleAlert`) uses `text-error` / `text-warning`.
- **Type:**
  - The status line and meta counters are mono runs (`font-mono text-sm` / `text-xs`, never `font-medium`).
  - Names, folders and drive labels inside sentences use `InlinePill`.
  - Sentence case; no `uppercase`.
- **Motion:** rows enter and leave with `SlideCollapse` (`@libreloom/ui/components/common/SlideCollapse.jsx`), and the dock height uses `useAnimatedHeight`.
- **Hints:** `InfoHint` beside Replace and Keep both (§2.11).

### 2.11 Exact user-facing strings

`{name}`, `{folder}`, `{drive}` render as `InlinePill` (`{folder}` falls back to the drive label at the drive root). `{n}` is a number. `{size}` uses `fmtSize`. `{pct}` is a rounded percent.

**Dock header**

| Situation | Text |
|---|---|
| Something running | `Working on your files` |
| Nothing running, problems left | `Some files need you` |
| Collapsed summary (mono) | `{n} running · {pct}%`, plus ` · {n} need you` when there are problems. A single upload operation reads `Uploading {n} files · {pct}%`. |
| Expand / collapse button aria | `Show details` / `Hide details` |
| Close button (only when nothing runs) aria | `Close` |

**Operation status line, while running → when done**

| Kind | Running | Done | Partial |
|---|---|---|---|
| upload (1 file) | `Uploading {name}` | `Uploaded {name}` | n/a |
| upload (many) | `Uploading {n} files to {folder}` | `Uploaded {n} files to {folder}` | `Uploaded {done} of {n} files to {folder}` |
| upload (dropped folder) | `Uploading {name}` | `Uploaded {name}` | `Uploaded {done} of {n} files in {name}` |
| copy | `Copying {name} to {folder}` (many: `Copying {n} items to {folder}`) | `Copied {name} to {folder}` | `Copied {done} of {n} items to {folder}` |
| move | `Moving {name} to {folder}` | `Moved {name} to {folder}` | `Moved {done} of {n} items to {folder}` |
| trash (batch) | `Moving {n} items to Trash` | `Moved {n} items to Trash` | `Moved {done} of {n} items to Trash` |
| restore-trash (batch) | `Putting back {n} items` | `Put back {n} items` | `Put back {done} of {n} items` |
| purge | `Deleting {name} permanently` / `Deleting {n} items permanently` | `Deleted permanently` | `Deleted {done} of {n} items permanently` |
| empty-trash | `Emptying Trash on {drive}` | `Trash emptied` | n/a |
| restore-backup | `Restoring {name} from a backup` | `Restored as {name}` | n/a |
| zip (F8) | `Getting {name}.zip ready` | `Download started` | n/a |
| any, cancelled | `Cancelled` | | |

**Meta line (mono)**
- Uploads: `{done} of {n} files · {sizeDone} of {sizeTotal}`. During the walk: `Counting files… {n} found`.
- Jobs: `{pct}% · {sizeDone} of {sizeTotal}`, or `Starting…` when `total === 0`.
- Waiting for the job queue: `Waiting for Luna to finish other copies…`.

**Item lines**
- Active upload line: `{name}` + `{pct}%`; cancel icon aria `Cancel uploading {name}`.
- Network retry: `Connection lost. Trying again…`

**Decision rows**

| Decision | Text | Buttons | InfoHints |
|---|---|---|---|
| Upload clash, file there | `A file named {name} is already in {folder}.` | `Replace`, `Keep both`, `Skip` | Replace: `The file that's there now is overwritten.` Keep both: `The new one gets a number added, like {stem} (1){ext}.` |
| Upload clash, folder there | `A folder named {name} is already in {folder}.` | `Keep both`, `Skip` | `Luna can't replace a folder with a file.` |
| Copy/move clash, file there | `A file named {name} is already in {folder}.` | `Replace`, `Keep both`, `Skip` | Replace: `The file that's there now goes to Trash.` |
| Copy/move clash, folder there | `A folder named {name} is already in {folder}.` | `Keep both`, `Skip` | `Luna doesn't merge folders.` |
| broadens_access | lunad's message | `Move anyway` / `Copy anyway`, `Skip` | |

**Failed rows**
- Text: lunad's `error` / `apiErrorMessage(err, …)`. Fallbacks name the action:
  - `Luna couldn't upload this file. Try again.`
  - `Luna couldn't copy this. Try again.`
  - `Luna couldn't move this. Try again.`
  - `Luna couldn't empty the trash. Try again.`
  - `Luna couldn't delete this permanently. Try again.`
  - `Luna couldn't restore this from the backup. Try again.`
- Offline: `Couldn't reach Luna. Check this device's connection and try again.` (the existing `apiErrorMessage` string).
- Unreadable: `Your browser couldn't read this file from your device.`
- Buttons: `Try again` (retryable only), `Remove`.

**Operation buttons:** `Cancel` (running), `Clear` (finished with problems).

**Overflow:** `1 more problem →`, `{n} more problems →`

**Problems modal**
- Title: `Problems with this upload` / `Problems with this copy` / `Problems with this move` / `Problems with this task`.
- Footer: `Replace all`, `Keep both for all`, `Skip all`, `Try all again`, `Clear failed`.
- Note under the clash buttons: `Applies to the rest of this upload too.`

**Op-level error (single-file share link):** `Choose one file to replace this file.` (existing).

**Success toasts (one per operation)**

| Kind | Toast |
|---|---|
| upload | `1 file uploaded.` / `{n} files uploaded.` |
| gallery upload | `1 photo uploaded.` / `{n} photos uploaded.` |
| copy | `Copied {name} to {destLabel}.` / `Copied {n} items to {destLabel}.` |
| move | `Moved {name} to {destLabel}.` / `Moved {n} items to {destLabel}.` |
| trash, restore-trash, purge, empty-trash | Existing strings: `Moved to Trash.`, `Moved {n} items to Trash.`, `Restored.`, `Restored {n} items.`, `Deleted permanently.`, `Deleted {n} items permanently.`, `Trash emptied.` |
| restore-backup | `Restored as {name}.` |

Toast text is plain: no pills.

**lunad job error suffixes (R1, server text):**
- Copy that failed: `… Luna removed the partial copy.`
- Copy that was cancelled: `Luna removed the partial copy.`
- Move that failed during the copy: `… Nothing was moved. Your files are still where they were.`
- Move that copied but couldn't move the originals to Trash: `The files were copied, but Luna couldn't move the originals to Trash. Both are there now.`
- Destination full: `{drive label} is full. Free up some space on it and try again.`

---

## 3. Order of the briefs

```
R1 (haiku, lunad) ─┐            ┌─ F2 (dock UI)
                   ├─ F7 (fake) │
F1 (store/engine) ─┘            └─ F3 → F4 → F5 → F6 → [R2 → F8 optional]
```

- R1 and F1 share no files and can run in parallel.
- F7 needs R1's contract.
- F2 needs F1's shapes. F7 and F2 can run in parallel.
- F3 to F6 all touch `DriveFileExplorer.jsx`, so they are **sequential**.
- R2/F8 come last and can be deferred.

Self-check rules for every brief: never run tests. Frontend agents may run only `cd luna/web && npm run typecheck && npm run scan:colors`. Rust agents may run only `cargo check -p lunad --tests`. The orchestrator runs `./ci` later.

---

## 4. Briefs

### R1: lunad clash codes, keep-both, job error wording (model: **haiku**)

**Owned files:**
- `luna/crates/lunad/src/api/uploads.rs`
- `luna/crates/lunad/src/files/uploads.rs`
- `luna/crates/lunad/src/api/files.rs` (the `upload` handler and `UploadQuery` only)
- `luna/crates/lunad/src/api/access/access_public.rs` (`public_upload_complete` and its query struct only)
- `luna/crates/lunad/src/api/jobs.rs`
- `luna/crates/lunad/src/jobs.rs`
- `luna/crates/lunad/src/jobs/tests.rs`
- `luna/crates/lunad/src/api/files/http_tests.rs`
- the test module for `api/uploads.rs` (where it lives today)

**Changes:**
1. `files/uploads.rs`: make `find_free_name` `pub(crate)`.
2. **The `409 exists` body.** Wherever an upload or job refuses because the name is taken, answer `409` with:
   ```json
   {"error": <existing text>, "code": "exists", "existing_kind": "file"|"dir"}
   ```
   `existing_kind` comes from `symlink_metadata(dest).is_dir()`. Build the body with `json!`; `json_error_code` has no extra field.
   - Where: `api/uploads.rs` `map_upload_err` (both `AlreadyExists` arms, when the kind is knowable, else omit `existing_kind`), the `api/files.rs` multipart `upload` 409, and the job clash.
3. `api/uploads.rs` `create`:
   - Add `#[serde(default)] on_conflict: Option<String>` to `CreateBody`.
   - After `check_access`, resolve the folder with `files::dest_dir` (not `_create`; a missing folder means no clash).
   - If `files::name_taken(dir, safe_name)` and `on_conflict` is `None`, return the `409 exists`.
   - Also, if `crate::drives::summary::disk_space(&dir)` is available and `free_bytes < size`, return `507` `"This drive is full. Free up some space and try again."` (the existing string).
4. `api/uploads.rs` `complete`: add `keep_both: Option<String>` to `CompleteQuery`. Pass `rename_on_conflict = keep_both == "1"` into `uploads::complete`. `overwrite` wins if both are set.
5. `api/files.rs` `upload`: add `keep_both: Option<String>` to `UploadQuery`. When `dest.exists()`, `!overwrite` and `keep_both == "1"`, set `name = find_free_name(&dir, &name)` and recompute `dest` and `rel`. The returned `FileEntry.name` is the final name.
6. `access_public.rs` `public_upload_complete`: accept `keep_both=1`. `rename_on_conflict = (link.caps & CAP_VIEW == 0) || keep_both == "1"`.
7. **Job name clashes.** `jobs.rs`:
   - Add `JobError::NameTaken { existing_dir: bool }`, returned by `prepare`'s name check instead of `Conflict`. Keep `Conflict` for the private-prefix case.
   - Add `on_conflict: OnConflict { Fail, KeepBoth }` to `enqueue` and `prepare`. `api/jobs.rs` `CreateJob` gets `#[serde(default)] on_conflict: Option<String>`; `"keep_both"` → `KeepBoth`, anything else → `Fail`.
   - With `KeepBoth` and a plain source (`src_item.is_none()`), set `name = find_free_name(&dest_dir, &name)` and recompute `dest` / `dest_rel`.
   - With a private source item, return `409` `code: "keep_both_unsupported"`, `"Luna can't keep two private items with the same name here. Choose Skip, or rename one first."`
   - `map_job_err(NameTaken)` → the `409 exists` body with `existing_kind`.
   - `plain_job_error(NameTaken)` = `"A file or folder with this name is already there."`
8. `api/jobs.rs` `map_job_err(QueueFull)` → `json_error_code(503, "queue_full", <existing text>)`.
9. **Job end in `jobs.rs` (`(state, error)` block):**
   - Call `update_job_progress(total, total)` **only when `state == "done"`**.
   - For `error` where `st.owned_dest` cleanup runs, append `" Luna removed the partial copy."` (copy) or `" Nothing was moved. Your files are still where they were."` (move).
   - For a cancelled copy, set `error` to `"Luna removed the partial copy."`
   - For the move-to-Trash failure branch (`st.owned_dest = false` after the copy), use the message `"The files were copied, but Luna couldn't move the originals to Trash. Both are there now."` (new `JobError` variant or a dedicated string).
   - For no-space errors, look up the destination drive label (`db::get_drive`) and write `"{label} is full. Free up some space on it and try again."`, plus the copy/move suffix.
   - Use `ErrorKind::StorageFull` / `QuotaExceeded` alongside the existing `"No space"` string match.
10. **Tests** (added, not run):
    - Upload create clash → `409 exists file`.
    - Create with `on_conflict` → 200.
    - `complete?keep_both=1` → `name (1).ext`.
    - Multipart `keep_both=1`.
    - Create when free space is short → 507.
    - Job clash → `409 exists` with `existing_kind: "dir"` for a folder.
    - Job `on_conflict: "keep_both"` lands `name (1)`.
    - Private source keep-both → `keep_both_unsupported`.
    - Failed job keeps its real progress and gets the suffix.
    - `queue_full` code.

**Acceptance:**
- All the `409`s above carry `code` (and `existing_kind` where stated).
- No existing message text changes except the job errors listed.
- `cargo check -p lunad --tests` is clean.

**Scenarios unblocked (on a real lunad):** `files/upload-duplicate`, `files/upload-no-space-huge`, `files/copy-fails-drive-full`, `files/move-fails-partway` (wording), `files/move-name-clash`.

**Self-check:** run `cargo check -p lunad --tests`. Then grep that every `StatusCode::CONFLICT` for a taken name in the owned files goes through the new body.

---

### F1: store, runners, walker, fileSource (model: **sonnet**)

**Owned files (new):**
- `luna/web/src/lib/fileOps/store.js`
- `luna/web/src/lib/fileOps/uploadRunner.js`
- `luna/web/src/lib/fileOps/jobRunner.js`
- `luna/web/src/lib/fileOps/requestRunner.js`
- `luna/web/src/lib/fileOps/errors.js`
- `luna/web/src/lib/fileOps/selectors.js`
- `luna/web/src/lib/fileOps/copy.js` (every string in §2.11 as functions)
- `luna/web/src/context/FileOpsContext.jsx`
- tests: `luna/web/src/lib/fileOps/store.test.js`, `uploadRunner.test.js`, `jobRunner.test.js`, `selectors.test.js`, `luna/web/src/context/FileOpsContext.test.jsx`

**Owned files (edit):**
- `luna/web/src/lib/fileSource.jsx`
- `luna/web/src/lib/collectUploadFiles.js` (+ its test)
- `luna/web/src/App.jsx` (provider only; F2 adds the dock)

**Changes:**
1. **`store.js`:**
   - Exports `createFileOpsStore({ queryClient, addToast, haptic, now = Date.now, setTimer = setTimeout })`, implementing §2.1–2.7 and the model in §2.3.
   - Actions:
     - `startUpload({ source, driveId, destFolder, destLabel, dropped?, files?, kind?: "upload"|"gallery", invalidateKeys?, afterFinish? })`
     - `startJobs({ kind, fromDrive, items: [{ path, name }], toDrive, toPath, toLabel })`
     - `startRequest(…)`
     - `decide(opId, itemId, choice)`
     - `decideAll(opId, choice)`
     - `retry(opId, itemId?)`
     - `cancel(opId, itemId?)`
     - `dismiss(opId)`
     - `hasBrowserWork()`
     - `subscribe`, `getState`
   - `initialOps` option for tests.
   - Emits throttled to 100 ms for progress.
2. **`uploadRunner.js`:** the global pool (`UPLOAD_PARALLEL = 3`), the name check before upload (§2.4), the decision rules, online retry, `mkdir` for empty folders, and per-folder invalidation through `fileListKey(op.source, op.driveId, folder)`.
3. **`jobRunner.js`:** the client queue (max 4), polling `/api/v1/jobs?limit=200` filtered to this tab's ids, `queue_full` waits, and the clash/broaden decisions. Replace = `source.remove`, then submit again (§2.5). Invalidation keys as in §2.5.
4. **`requestRunner.js`:** runs items in order, continues past failures, indeterminate when there is no count.
5. **`errors.js`:** `classifyError(err, kind)` → `{ message, retryable, decision? }`.
   - Keys off `err.status`, `err.code` (`exists` with `err.data.existing_kind`, `broadens_access`, `queue_full`, `keep_both_unsupported`).
   - Status 0 = retryable.
   - Uses `apiErrorMessage` with the fallbacks in §2.11.
6. **`selectors.js`:** dock visibility (600 ms rule), header summary, per-op inline problem plus overflow count, problem list.
7. **`FileOpsContext.jsx`:**
   - `FileOpsProvider` (creates the store once with `useRef`, injects `useQueryClient` / `useToast().addToast` / `haptic`), `useFileOps()`, `useFileOpsState(selector)` (`useSyncExternalStore`).
   - The `beforeunload` guard on `hasBrowserWork()`.
   - The `pagehide` keepalive `DELETE` for open chunked sessions (drive and share URLs, using `withCsrfHeaders` and the share password header that the share source exposes; add `source.cancelUploadUrl(uploadId)` → `{ url, headers }` if needed).
8. **`fileSource.jsx`:**
   - `uploadFile(driveId, file, destPath, name, { signal, onSession, onProgress, onConflict, onRetry })`. `onConflict` is `"replace"` or `"keep_both"`:
     - multipart: `&overwrite=1` / `&keep_both=1`
     - chunked: `on_conflict` in the create body, and `?overwrite=1` / `?keep_both=1` at complete
   - Returns the server entry, so the final name is known.
   - In the chunked catch, **don't** `DELETE` the session when the error is `409` with `code === "exists"` at `/complete`. Throw an error carrying `uploadId` and `completeOnly: true`.
   - Add `completeUpload(driveId, uploadId, onConflict)`.
   - Pass `onRetry` through to `sendChunkWithRetry`, which drives the `Connection lost. Trying again…` line.
   - Same for `shareSource.uploadBlob` (`keep_both=1` at complete).
   - Keep `uploadFile`'s old call shape working for `createFileMutation` and editors.
9. **`collectUploadFiles.js`:** add `takeDropped(dataTransfer)` (synchronous) and `walkDropped(dropped, { onFile(file, relPath), onDir(relPath), onError(relPath, err) })`. Per-entry try/catch, `readEntries` batches, picker `webkitRelativePath`. Keep `uploadDestForFile`, and keep `filesFromDataTransfer` for existing callers until F3/F4 remove them.
10. **`App.jsx`:** wrap `<FileOpsProvider>` inside `ToastProvider` so it encloses `ShortcutsProvider` / `AuthProvider` / `Routes`.

**Acceptance:**
- No component imports yet, other than `App.jsx`.
- Every string comes from `copy.js`.
- JSDoc types pass typecheck.
- **Logic tests** cover:
  - The pool never runs more than 3 at once across two operations.
  - A clash parks one item while the others finish.
  - `decideAll` sets the policy for later clashes.
  - A chunked `completeOnly` decision calls `/complete` again, not the PUTs.
  - A walker error on one entry doesn't stop the others.
  - A job `error` state becomes a failed item with lunad's text and is never dropped.
  - `queue_full` waits.
  - `hasBrowserWork()` is true while uploading and false once only accepted jobs remain.
  - One success toast per operation, none when nothing succeeded.
- **Render test** for `FileOpsContext` (provider + a probe component).

**Scenarios closed:** `files/upload-slow` (c), together with F3.

**Self-check:** `npm run typecheck`, `npm run scan:colors`. Grep: no `localStorage` / `sessionStorage` in `lib/fileOps/`, and no `addToast({ type: "error"` in `lib/fileOps/`.

---

### F2: dock, rows, problems modal (model: **sonnet**)

**Owned files (new):**
- `luna/web/src/components/files/fileOps/FileOpsDock.jsx`
- `luna/web/src/components/files/fileOps/FileOpRow.jsx`
- `luna/web/src/components/files/fileOps/FileOpItemLine.jsx`
- `luna/web/src/components/files/fileOps/FileOpProblemsModal.jsx`
- `luna/web/src/components/files/fileOps/FileOpProgress.jsx`
- render tests for each: `*.test.jsx`

**Owned files (edit):** `luna/web/src/App.jsx` (`<FileOpsDock />` in `AppShell` between `PageOutlet` and `Navbar`).

**Changes:**
- Implement §2.2, §2.7, §2.10 and §2.11 against `useFileOpsState` / `useFileOps`.
- `FileOpProgress` takes `pct | null` and `surface`. `null` renders `LinearProgress`.
- `FileOpItemLine` covers three cases: active upload, decision (buttons from `item.decision.options`, InfoHints) and failed (`Try again` when retryable, `Remove`).
- The dock opens itself on the first new problem.
- `SlideCollapse` for rows, `useAnimatedHeight` for the body.
- No raw `keydown`. No `font-mono` mixed with weight classes. No `text-accent`. No `uppercase`. Names in sentences through `InlinePill`.

**Acceptance:**
- The dock renders nothing with no visible operations.
- Render tests use `createFileOpsStore({ initialOps })` fixtures for:
  - one running upload
  - a folder upload with 15 clashes (shows the first clash plus `14 more problems →`, and the modal lists 15 with `Replace all` / `Keep both for all` / `Skip all`)
  - a folder clash (no Replace)
  - an offline-failed item (`Try again`)
  - a failed job showing lunad's text
  - empty trash (indeterminate)
  - collapsed summary text
- The contrast and surface-mismatch helpers pass in every test (that's automatic in vitest; don't opt out).

**Scenarios closed:** none on its own. It gives the UI for F3–F6.

**Self-check:** `npm run typecheck`, `npm run scan:colors`. Every outline/ghost `Button` inside a `surface-primary` row has `surface="primary"`.

---

### F3: explorer uploads and folder upload (model: **sonnet**)

**Owned files:**
- `luna/web/src/components/files/DriveFileExplorer.jsx`
- `luna/web/src/components/files/FileBrowser.jsx`
- `luna/web/src/components/files/UploadFilesPanel.jsx`
- tests: `luna/web/src/components/files/FileBrowser.test.jsx`, `luna/web/src/components/files/UploadFilesPanel.test.jsx`, `luna/web/src/components/files/DriveFileExplorer.private.test.jsx`
- new `luna/web/src/components/files/DriveFileExplorer.uploads.test.jsx`

**Changes:**
1. **`DriveFileExplorer`:**
   - Delete the `uploads` / `uploadsRef` state, `patchUpload` / `removeUpload` / `cancelUpload`, `mapPool`, `UPLOAD_PARALLEL` and the `UploadProgressList` render.
   - `uploadFiles(input, destFolder)` → `fileOps.startUpload({ source, driveId, destFolder, destLabel: <folder name or driveLabel>, dropped | files })`.
   - Keep the `source.isFile && >1 file` rule as an op-level error.
   - Keep `export function UploadProgressList` for now (F4 removes it).
2. **`FileBrowser`:**
   - In `handleOsDrop` / `onFolderDrop`, call `takeDropped(e.dataTransfer)` **synchronously** and pass `{ dropped }` to `onUploadFiles`. The JSDoc type of `onUploadFiles` becomes `(input: { dropped } | { files: File[] }, destPath) => void`.
   - The Upload button becomes the `Dropdown` from §2.8, with the folder input and the `shift+u` shortcut.
3. **`UploadFilesPanel`:** take `dropped` / folder input the same way, add `Choose a folder`, and drop `localError` for upload failures (rows own them).
4. Make sure no upload error reaches `setActionError`.

**Acceptance:**
- Navigating from Files to Dashboard and back keeps the same uploads running and visible.
- Two drops share the one pool.
- A folder drop keeps its structure and creates empty folders.
- A clash shows Replace / Keep both / Skip in its row while the other files keep uploading.
- Read-only, no space and offline errors show in their row, never as a toast.
- Tests are updated for the new prop shape.
- New render test: a dropped folder with one clash renders a decision row.

**Scenarios closed:** `files/upload-ok`, `upload-slow` (b, c), `upload-fails`, `upload-duplicate`, `upload-offline`, `upload-into-readonly`, `upload-no-space-huge`, `upload-folder`. Regression checks: `upload-huge`, `upload-huge-flaky`.

**Self-check:** `npm run typecheck`, `npm run scan:colors`. Grep `DriveFileExplorer.jsx` for `setActionError(apiErrorMessage(err, "Couldn't upload`: there must be none.

---

### F4: share-link and gallery uploads (model: **sonnet**)

**Owned files:**
- `luna/web/src/pages/PublicSharePage.jsx`
- `luna/web/src/pages/GalleryPage.jsx` (`uploadFiles` and its UI only)
- `luna/web/src/components/files/DriveFileExplorer.jsx` (delete the `UploadProgressList` export only)
- tests: `luna/web/src/pages/PublicSharePage.test.jsx`, `luna/web/src/pages/GalleryPage.test.jsx`

**Changes:**
- **`PublicSharePage`:** remove its own `uploads` state, `uploadOne`, its batch loop and `UploadProgressList`. Use `startUpload({ source, driveId: token, … })`, and render `<FileOpsDock />` inside the page (it sits outside `AppShell`).
  - Drop-box links never get decisions (lunad renames).
  - `batchDone` UI reads from the store's operation state.
- **`GalleryPage`:** `uploadFiles` → `startUpload({ kind: "gallery", destFolder: "Photos", invalidateKeys: [["gallery"], ["gallery-status"]], afterFinish: () => rescan })`. The same drive choice as today, so progress and clashes work.
- Delete the `UploadProgressList` export from `DriveFileExplorer.jsx`.

**Acceptance:**
- Guest uploads show in the dock with per-row errors.
- The gallery upload shows progress and continues past a clash.
- Gallery toast: `{n} photos uploaded.`
- Render tests are updated.
- `grep -r UploadProgressList luna/web/src` finds nothing.

**Scenarios closed:** sharing upload scenarios in `sharing.scenarios.js` that involve uploading. Regression run by the orchestrator.

**Self-check:** `npm run typecheck`, `npm run scan:colors`.

---

### F5: copy/move jobs (model: **sonnet**)

**Owned files:**
- `luna/web/src/components/files/DriveFileExplorer.jsx` (`transferMutation`, `internalMoveMutation`, `jobs` query, `prevBusyJobIds`, broaden `ConfirmModal`)
- `luna/web/src/hooks/useDriveMove.js` (+ `useDriveMove.test.jsx`)
- `luna/web/src/pages/FilePage.jsx` (+ `FilePage.test.jsx`)

**Changes:**
- Signed-in copy/move → `startJobs(...)`. The picker modal closes on choosing a destination. The guest same-link move (`source.move`) stays as it is, with its toast.
- `useDriveMove` becomes a thin wrapper over `startJobs` (same call shape for its callers), with no `onBroaden` / `onError` for job failures.
- **`FilePage`:** delete the `jobs` query, `cancelMutation`, the `activeJobs` cards, the broaden `ConfirmModal` and its state. Remove the explorer's `jobs` query and `prevBusyJobIds` effect (the store invalidates now).
- Remove the enqueue toasts.
- Destination label for rows and toasts: the folder name, or the drive label at the root.

**Acceptance:**
- A failed copy or move stays as a failed row with lunad's text. It is never dropped.
- Multi-select of 10 items to another drive: every item is sent (the client queue respects the limit of 4).
- A copy into the same folder offers Keep both / Skip.
- A folder clash offers no Replace.
- Leaving the page while only accepted jobs run doesn't warn.
- Tests updated, plus a render test of `FilePage` that has no job cards.

**Scenarios closed:** `files/copy-job`, `files/move-job`, `files/copy-fails-drive-full`, `files/move-fails-partway` (the silent part), `files/move-name-clash`, `files/copy-to-full-drive` (now a failed row: see F7's check text).

**Self-check:** `npm run typecheck`, `npm run scan:colors`. `grep -rn "Luna is copying\|Luna is moving\|jobBusy" luna/web/src --include=*.jsx --include=*.js | grep -v dev/` finds nothing.

---

### F6: long one-shot and batch operations (model: **sonnet**)

**Owned files:**
- `luna/web/src/components/files/DriveFileExplorer.jsx` (`removeMutation`, `restoreMutation`, `purgeMutation`, `emptyTrashMutation` and their modals)
- `luna/web/src/components/files/backupsView.jsx` (`BackupRowActions` restore only) + `backupsView.test.jsx`

**Changes:**
- Trash (more than one item), restore from Trash (more than one item), delete permanently, empty trash, and the backup row restore go through `startRequest`. Their confirm modals close on confirm. Errors show in rows, and the work continues past failed items.
- Single-item trash and restore stay as they are.
- The `VersionsModal` restore stays in its modal.
- `broadens_access` on a batch restore becomes a row decision (`confirm` resends with `confirm_broaden: true`).

**Acceptance:**
- Empty trash shows `Emptying Trash on {drive}` with an indeterminate bar after 600 ms, then the `Trash emptied.` toast.
- A failure stays in its row.
- Deleting 40 selected items where one fails deletes the other 39 and shows 1 problem.
- Render tests updated.

**Scenarios closed:** `files/trash-empty-all` ("error stays visible"), `files/delete-to-trash` (batch path).

**Self-check:** `npm run typecheck`, `npm run scan:colors`.

---

### F7: fake lunad and scenarios (model: **sonnet**)

**Owned files:**
- `luna/web/src/dev/fake/handlers/files.js` (uploads and jobs sections only)
- `luna/web/src/dev/scenarios/files.scenarios.js`
- `luna/web/src/dev/files.test.js`

**Changes:**
1. **Uploads in the fake:**
   - Create missing folders (`ensureDirs`) instead of `needFolder`, like `dest_dir_create`.
   - `POST /uploads` refuses a clash with `409 { code: "exists", existing_kind }` unless `on_conflict` is set.
   - `/complete` and multipart honour `overwrite=1` / `keep_both=1` (`uniqueName` with lunad's ` (1)` numbering), and also clash at `/complete` when the name appeared after create.
2. **Jobs in the fake:**
   - State `error` (not `failed`).
   - No `queued` state.
   - Clash → `409 exists` with `existing_kind` unless `on_conflict: "keep_both"`.
   - `503 queue_full` past 4 running per user.
   - Failure messages and suffixes match R1.
   - Progress stays at the failure point.
   - (The job-atomicity fix is phase 1.6, already landed.)
3. **Scenarios:**
   - `move-fails-partway` → a **cross-drive** move to Backup (a same-drive move is a rename in lunad and can't fail halfway). Check text: `Row says it failed and "Nothing was moved. Your files are still where they were."`, `Spain is untouched; Backup has no partial copy`.
   - `move-name-clash` check: `the copy offers Keep both / Skip; Keep both lands notes (1).txt`.
   - `copy-to-full-drive` check: `refused straight away; the row says there isn't enough room and no bar keeps running`.
   - `upload-ok` check: `Three at a time, rest wait`.
   - `upload-slow` checks add: `Navigate to Dashboard and back: the same upload is still running in the card`.
   - New: `files/upload-many-clashes` (seed 15 names that clash; check `14 more problems →`, `Keep both for all`).
   - New: `files/upload-folder-mixed` (folder with clashes plus a name lunad refuses; the rest uploads).
   - New: `files/trash-empty-slow` (fault `slow:6000` on purge).
   - New: `files/restore-backup-slow`.
4. **Seed tests** for the new scenarios (seeds don't throw), plus handler cases for `keep_both` and `queue_full`.

**Acceptance:** the fake answers what lunad (after R1) answers for every case above. If plan 1.8 contract fixtures exist, they include the new fields.

**Scenarios closed (for retest):** all of `files/upload-*`, `files/copy-*`, `files/move-fails-partway`, `files/move-name-clash`, plus the new ones.

**Self-check:** `npm run typecheck`, `npm run scan:colors`.

---

### R2 + F8 (optional, last): folder zip with a prepare step

**R2 (haiku).** Owned files: `luna/crates/lunad/src/api/files.rs` (new routes only), `luna/crates/lunad/src/api/files/http_tests.rs`.
- `POST /api/v1/drives/{id}/files/zip {path}`:
  - Builds the zip exactly as `serve_folder_zip` does, in `spawn_blocking`.
  - Keeps the tempfile in an in-memory map: `token → (tempfile, name, user_id, expires = 10 min)`.
  - Answers `{ token, name, size }`, with the same errors as today.
- `GET /api/v1/zips/{token}`:
  - Same user only, used once.
  - Streams with `Content-Disposition`.
  - Deletes the entry when done.
- Tests: owner-only, single use, expiry.
- Self-check: `cargo check -p lunad --tests`.

**F8 (sonnet).** Owned files: `DriveFileExplorer.jsx` (`DownloadButton` folders), `FileBrowser.jsx` (`d` shortcut and the selection Download, folders only), `FileRow.jsx` (folder download), `lib/fileOps/requestRunner.js`, tests.
- A folder download becomes a `zip` request operation: `Getting {name}.zip ready`, then a hidden anchor to `/api/v1/zips/{token}` and `Download started`.
- Errors in its row.
- Share links stay on `/s/{token}/zip`.
- Closes no current scenario. Add `files/download-big-folder` in F7's file if F7 has landed.

---

## 5. Gallery scenarios → briefs

| Scenario | Closed by |
|---|---|
| `files/upload-ok`, `upload-huge`, `upload-huge-flaky` (regression) | F3 |
| `files/upload-slow` a | phase 1.7 |
| `files/upload-slow` b | F3 |
| `files/upload-slow` c | F1 + F3 |
| `files/upload-fails`, `upload-offline`, `upload-into-readonly`, `upload-no-space-huge` | F3 (+ R1 for the up-front `507` on real lunad) |
| `files/upload-duplicate` | R1 + F1 + F3 |
| `files/upload-folder` | F1 (walker) + F3 |
| `files/copy-job`, `files/move-job` | F5 |
| `files/copy-fails-drive-full` | R1 (wording) + F5 |
| `files/move-fails-partway` (silent part) | R1 + F5 + F7 (scenario made realistic) |
| `files/move-name-clash`, `files/copy-to-full-drive` | R1 + F5 + F7 |
| `files/trash-empty-all` | F6 |

## 6. Out of scope (logged)

- **Gallery "download selected" zip into memory:** needs R2's prepare pattern for `/api/v1/gallery/download`.
- **Signing out while uploads run:** this stream adds no in-app guard. Rows fail with a sign-in error and can be retried.
- **Editor saves, form pictures, cloud and private restore:** they keep their own state.

## 7. Choices Max can overrule

1. **The dock is global** (every in-app page, bottom right), not only on Files pages. "Universal through the file explorer" was read as "never lost while you move around the app".
2. **After a reload the card starts empty**, even for copy/move jobs still running on Luna. They finish, but a failure after a reload isn't shown. Alternative: keep this tab's job ids in `sessionStorage` (per tab, survives reload) and pick them back up.
3. **Replace means different things:**
   - An upload overwrites the file in place, which keeps its shares.
   - A copy or move first sends the old file to Trash.
   - Lunad never merges or replaces folders: Keep both / Skip only.

### Critical files for implementation
- /home/plainskill/Projects/LibreServ/luna/web/src/components/files/DriveFileExplorer.jsx
- /home/plainskill/Projects/LibreServ/luna/web/src/lib/fileSource.jsx
- /home/plainskill/Projects/LibreServ/luna/web/src/lib/collectUploadFiles.js
- /home/plainskill/Projects/LibreServ/luna/crates/lunad/src/jobs.rs
- /home/plainskill/Projects/LibreServ/luna/crates/lunad/src/api/uploads.rs
## 8. Orchestrator decisions (23 Oct 2026)

- Choice 1 is kept: the dock is global, across every in-app page.
- Choice 2 is overruled, because "per-tab" points to the tab, not the page load. F1 keeps this tab's accepted job ids in
  `sessionStorage` (`luna.fileOps.jobs`), so after a reload the dock picks those jobs back up and shows
  how they ended. Browser uploads still can't survive a reload. This is the one allowed use of
  `sessionStorage` in `lib/fileOps/`.
- Choice 3 is kept.
