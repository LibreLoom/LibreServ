# States gallery feedback — plan

Status: the harness rebuild and the streams landed 23–26 Oct 2026 (commits `fb8ca0a7` … `86b5161a`); kept as the record of the triage and decisions. Live harness docs: `luna/web/src/dev/README.md`.

Source: the 51 `fail` notes in `luna/web/testing/results.json` (21–24 Oct 2026), plus a
review of the whole harness in `luna/web/src/dev/`. Every note is listed below exactly once.
When a fix lands, mark the scenario *Fixed, retest* in the gallery. Don't edit `results.json`
by hand.

Order: **0 → 1 → 2/3/4 in parallel → 5 streams**. Phase 1 comes before any product fix that
depends on a "could be a mock bug" note, so we stop chasing fake bugs as if they were real ones.

---

## 0. Data-loss triage (first, on a real lunad)

| Scenario | Note | What the code says | Action |
|---|---|---|---|
| `files/move-fails-partway` | Source deleted, silent | Real `jobs.rs`: a cross-drive move copies everything first, then trashes the source; a same-drive move is a single rename. The fake's `applyJob` deletes each source node as it copies, including the folder node itself (it sorts first). | Reproduce on real lunad with a failure injected mid-copy. Expected: the bug is fake-only. The fake fix is in 1.6. The silent part is real: see stream A. |
| `files/delete-to-trash` | Deleting a folder after trashing an item inside it deletes the folder for good | Real `files/mod.rs` trashes with a no-replace rename and a nonce loop, which looks safe. | Reproduce on real lunad, both in the UI and through the API. If real: fix + regression test before anything else. If fake-only: covered by 1.6. |

## 1. Harness rebuild (root causes)

The fake was built as "answer something for every path". It needs to be "answer what lunad
answers". These defects explain most of the "harness is broken / mock bug" notes:

1. **Fault matching is substring.** `GET /api/v1/drives` also breaks `/drives/d1/summary`, `/files`, `/health`…
   → `dashboard/drives-fail` ("just doesn't load"), likely `files/listing-error` (no retry: `/files/stat` also failed).
   Fix: exact path match by default, `*` as an explicit wildcard, optional `?query` match. The gallery shows how many requests each rule caught.
2. **Duplicate routes win silently** (the first one registered wins; `core.js` holds dead copies of `/backups`, `/backups/covered`,
   `/backups/:id/run`, `/private-backups/item`, `/users/:id/adopt-private`). Fix: `route()` throws on a duplicate
   method+pattern, and the dead copies are deleted. Module order in `handlers/index.js` stops mattering.
3. **Method blind spots.** The app `POST`s `/drives/:name/inspect`, but the fake registers `GET`, so the call gets a 501 and the page says
   "Luna couldn't look at this drive safely" (`dashboard/new-drive-found`). `states:coverage` ignores methods and
   template helpers (`base(driveId, id)`), so it never caught this. Fix: coverage matches method + path, and also reads
   helper-built URLs (or records real calls during a scripted walk of every scenario).
4. **No access model.** The fake `GET /drives` returns every drive with no `writable`/`caps`. Real lunad filters by
   `has_drive_access` and hides `device`/`mount_point` from Members. Most handlers ignore `user`;
   `settings.js` never checks the user at all. → `dashboard/member-calm`, `dashboard/member-with-problems`, read-only scenarios.
   Fix: one `policy.js` that mirrors lunad (admin gate, drive access, caps on path, private owner), used by
   every handler. Handlers that are admin-only in lunad answer 403 to Members.
5. **State that should persist doesn't.** POST `/me/recents` prepends without dedupe, while lunad upserts on
   (user, drive, path) → `dashboard/recents-many`. Rename/move doesn't re-path recents (lunad does).
   `files/resolve` 404s → `files/moved-link` lands on "Drive not found".
   The world resets on every full page load (sign-out redirect, update restart, `window.location`), so the session
   comes back, or a flow restarts mid-way. Fix: keep the world in `sessionStorage` per frame; only the
   gallery's *Reload (fresh data)* wipes it.
6. **Jobs are not atomic like lunad.** `applyJob` deletes the source while copying (see 0). Fix: copy everything, then
   trash the source once the copy is done, same as `jobs.rs`. A failure leaves the source untouched and a partial copy at
   the destination.
7. **`FakeXHR` is not an XHR.** Its progress steps run *before* dispatch, so latency and `slow:` faults hold the bar at 100%
   (`files/upload-slow` a). It only calls `on*` properties, never `dispatchEvent`, so listener-based code
   gets nothing. It has no `readyState` changes, `loadend`, `timeout`, `response`, `getResponseHeader` or
   `abort` status, and abort mid-dispatch still writes the file. Fix: a proper XHR shim that streams progress across the
   real wait, fires both property and listener events, and honours abort. Then re-check `files/empty-drive`
   ("upload does not work").
8. **Response shapes drift from lunad.** Examples found: backup `versions` (real: `at: null` for current, plus `mtime`;
   fake: `current: true`) → `files/backups-browse` "no multiple versions"; fake backup rows never set
   `private`/`private_owner`, so `covered` never matches inside private items; `inspect` is missing `unreadable`,
   `mount_point`, `mounted_by_luna`; drive list is missing `writable`/`caps`. Fix: **contract tests**. lunad's API tests
   write the real JSON for every GET they exercise to `luna/web/src/dev/contract/*.json` (the same way the
   cloud `fixture.json` is made). A vitest calls each fake handler against the base world and compares keys and
   types against that fixture. A drift fails CI.
9. **Errors inside a handler reject `fetch`** instead of answering. Fix: a thrown non-`Res` answers 500 and shows
   "fake crashed: <stack>" in the gallery's red banner, so it is never taken for an app bug.
10. **Small engine fixes.** `emit()` fires twice per request. `nextId` uses one counter for every prefix and can
    collide with seeded ids (`u1`, `d1`). `backup()` burns an id even when given one. The log stores the frozen-clock `t`.
    `freezeClock` is lost on navigation inside the frame.
11. **Gallery gaps.**
    - **Sign in as…** switcher (Admin / Member / signed out) for any scenario. `files/unplugged-at-start` could not test the
      Member wording.
    - The fault list shows a hit count per rule.
    - Clicking "Open on its own" gets a fresh world.
    - "Recent requests" shows the response body on click.
12. **Tests for the harness itself.** Matcher cases, the duplicate-route throw, XHR progress under `slow:`, job atomicity,
    member drive filtering, recents dedupe, world persistence across reload. Plus the contract test from 8.
    Today's `dev.test.js` / `files.test.js` only prove that seeds don't throw.
13. **Scenario hygiene.** Fix scenario checks that describe the wrong expectation. For example, `dashboard/drive-unhealthy`
    expects "working, with a warning" for one drive, but the user saw "needs attention" on both. Decide whether lunad's
    health `overall: "warning"` should read differently from `"failed"` (see stream C). Fix `dashboard/connect-token-error`
    too: the error shows above an empty token box.

After phase 1, retest every scenario whose note says "mock bug" / "harness": `backups-browse`, `empty-drive`,
`moved-link`, `new-drive-found`, `member-calm`, `member-with-problems`, `recents-many`, `connect-token-error`,
`drives-fail`, `listing-error`, `upload-slow`, `update-available` (lands on sign-in: the world resets on restart).

## 2. Copy fixes (small, independent)

| Scenario | Change |
|---|---|
| `auth/member` | Blocked card: "This page is only for Admins. Members can only change their own user settings." Check the other admin-only blocks too. |
| `dashboard/backup-stale` | Use one wording for a stale backup everywhere: "Last backed up 2 days ago." (real age, with a period). Drop "in over a day" and "in a day". Needs-you row body text one size smaller. |
| `dashboard/check-overdue` | Title "Check my phrase" (wall of shame). Grep the whole repo for the rest of the wall. Redesign: stream D. |
| `dashboard/everything-wrong` | "Drive full." → name the drive: "Backup drive is full." in backup errors (lunad `last_error` and the web). |
| `dashboard/system-check-failed` | "Storage space is nearly gone" → say whose storage: "Luna's own storage (the system disk) is nearly full", plus an InfoHint on what that is. |
| `files/create-collision` | Drop "Use a short name instead." |
| `files/drive-database-missing` | Add "No data on the drive will be lost." |
| `files/job-server-error` | "Luna's job queue isn't responding." (lunad message). |
| `files/missing-folder` | "You can use Universal Search to try and find it." Clicking it opens search. |

## 3. Small UI and behaviour fixes

| Scenario | Change |
|---|---|
| `auth/session-dies-mid-use` | "You were signed out" fires twice: one toast per outcome (dedupe in the 401 handler). |
| `auth/signed-out` | Empty username/password: inline error at each empty field (both when both are empty), shake. Never a dead button. |
| `dashboard/backup-source-missing` | "Needs another drive." becomes a status pill. The cloud section gets the same detail row as drives. "On" while not linked is wrong: it should say why. |
| `dashboard/drive-unmounted` | An unmounted drive must not read "healthy & ready": give it its own state on Files and in Needs you on the dashboard. |
| `dashboard/drives-fail` | After 1.1, check that the error and retry are real (a drive list that fails needs a "Try again"). |
| `dashboard/no-phrase` | **Decision needed:** make the phrase a required setup step so this can't happen, or show a Needs-you row. Also, why is it under Security / Devices? |
| `dashboard/update-applying` | Show "Installing update…" with a spinner, not just a missing button. |
| `dashboard/update-available` | After Start: keep a status ("Installing… Luna will restart") until `/health` comes back, then reload signed in. Retest after 1.5. |
| `dashboard/update-failed` | Dismiss button on the warning (`os-failed/clear` exists). |
| `files/listing-error` | "Try again" button on the error. |
| `files/listing-slow` | After ~1.5 s of loading, show "Still working" with a spinner in the file list. |
| `files/long-names` | Phone file rows: collapse the actions into the lightning menu, as Universal Search does. |
| `files/move-into-itself` | Hide or disable destinations inside the item being moved. |
| `files/move-readonly-dest` | Read-only drives stay in the header drive picker as usual. Dropping onto one fails with a clear error. |
| `files/rename-while-open` | The toast doesn't show: find out why (z-order under the viewer, or not fired). |
| `files/trash-restore-conflict` | Restore-with-new-name warns on an extension change, the same as rename. |
| `files/trash-restore-folder-gone` | Restoring when the original folder is gone recreates the folders above it (lunad and fake). |
| `files/unicode-emoji` | Phone editor: "Saved just now" in a pill. |
| `files/unplugged-at-start` | Card text is boxed too narrow (three lines instead of two): drop the max-width. Member wording: retest with 1.11. |
| `files/protect-inside-private` | Done in `29c9b3e8`: a folder inside a private item backs up as private. Retest. |

## 4. Drive health reporting (stream C)

`dashboard/drive-unhealthy`, `files/failing-drive`. Today: "The drive reported a problem… It's about 48°C",
with no meaning given, and `warning` and `failed` look the same. Plan:
- Explain each signal: temperature with its safe range ("48°C is warm; most drives are fine up to 55°C"),
  reallocated sectors ("parts of the disk have worn out"), SMART unavailable.
- `warning` (keep using it, watch it) is shown differently from `failed` (copy your files off now).
- One place for the details (drive detail sheet), one-line summary in Needs you.
- lunad: make sure health JSON carries which signal tripped, so the web doesn't guess.

## 5. Large streams (each its own session after this plan is approved)

**A. File operation card** (uploads + copy/move, persistent per tab). Covers `files/upload-slow` b/c, `upload-fails`,
`upload-offline`, `upload-into-readonly`, `upload-no-space-huge`, `upload-duplicate`, `upload-folder`,
`copy-job`, `copy-fails-drive-full`, `move-fails-partway` (the silent part).
- One card for every running file operation, kept in an app-level store so it survives navigation within the tab.
- Errors show in their own row, never only as a toast. Replace / Keep both / Skip in the row. With several problems, show
  "14 more problems →". Other files keep going while a decision waits.
- Folder upload (drag a folder, pick a folder), continuing past bad files.
- `beforeunload` guard while anything is running.
- Needs: the 1.7 XHR shim, and lunad's jobs API (already there) for copy/move.

**B. Performance review, Luna-wide** (`files/thousands`: typing lags). Start with the list: virtualize file rows, memoize
row renders, check query invalidation storms. Then a pass over lunad (listing, stat totals, search) and the companions
(desktop, mobile). Measure first, and write down the numbers.

**D. Recovery phrase check modal redesign** (`dashboard/check-overdue`). A first-class check flow: one word position at a
time, or the whole phrase with per-word feedback; clear success and failure; keyboard-first. Copy says "phrase".

---

## Decisions (23 Oct 2026)

Max: "the file operation card covers any file operation with length and is per-tab." Implement everything
with subagents. The defaults below were taken because the questions were not answered, so Max can overrule them:

1. `dashboard/no-phrase`: the recovery phrase becomes a required setup step, so a Luna can't be without one.
2. Stream order: A (file operation card) → C → D → B. The perf frontend work lands after A, because both touch the file list.
3. Contract fixtures (1.8) are generated from lunad's API tests.
