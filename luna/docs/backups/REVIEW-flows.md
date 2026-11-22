# Backup flows reviewed against SPEC.md (2026-11-21)

Review only. Nothing was changed, run or tested. Every claim below was read in the code on this date. Paths are under `luna/` unless they start with `connect/`. "Lunad" is `crates/lunad/src`, "web" is `web/src`. Severity: **broken** (a flow cannot work or loses or exposes something), **misleading** (works, but the person is told something untrue or nothing), **dead code**, **cosmetic**.

> **Status 2026-11-22:** fixed after this review: F-01 and F-13 (`e335611f`), F-02 (`adbd7079`), F-03 and F-17 (`ecd514bc`), F-04, F-05 and F-09 (`39956aad`), F-10 (`f96a2544`), F-11 (`adbd7079`; a re-added drive still gets a new id), F-14 (`de7dc8e4` plus the cloud caller in `39956aad`), and most of F-08 (waits now read as "Waiting" where the web recognises the message; the day rule is still missing). The findings and priorities below are the review as read at `646748f2`; `SPEC.md` is the current description.

## 1. Flow map

Each row walks UI -> API -> engine -> storage -> status shown back. "OK" means it matches SPEC; otherwise the finding id.

| # | Flow | Path | Result |
|---|---|---|---|
| 1 | Start a drive backup | `ProtectSheet.jsx` `createBackup` -> `POST /api/v1/backups` (`api/backups.rs`) -> `drive_backup::create` -> row + saved list -> first run spawned -> `.luna-<uuid>-backups/<id>/` | OK. Refusals match SPEC (Read, Write on target, whole drive Admin, private owner, same drive, encrypted to plain, folders only) |
| 2 | Start a cloud backup | `createCloud` -> `POST /api/v1/cloud/backups` -> `ops::create` -> first run -> packs + record on Connect | OK for creation (phrase 409, no card 402). Run behaviour: F-05, F-07, F-09, F-17 |
| 3 | Member's first cloud backup | Same, then `run.rs` `prepare` | F-08 |
| 4 | Private item backup | Own-shield `createBackup`/`createCloud`; `private_run.rs` for cloud | OK to start. Later life: F-13 |
| 5 | A run: failure, drive missing, mass-delete hold | `run_inner` steps 1-9 (drive), `run_once` (cloud) | F-08, F-09, F-10, F-14, F-16 |
| 6 | First upload progress | `backupHeadline` in `ProtectSheet.jsx` | F-07 |
| 7 | Quota full | `StoreError::Full` -> run problem | F-17 |
| 8 | Version thinning | Drive: `drive_store.rs` `thin`; cloud: `retention.rs` `thin` | Drive OK. Cloud F-05 |
| 9 | Restore from the Backups folder | `backupsView.jsx` -> `POST /api/v1/drives/{id}/backups/{bid}/restore` (`api/backup_folder.rs`) | Name clashes OK (tested, also checks hidden private items). Deleted source folder F-06. Gone private item: SPEC conflict 4 |
| 10 | Admin downloads on Connect | `connect/web` `UnlockCard` -> `cloudUnlock.js` -> `/storage` reads (`cloud_read.go`) | OK. Reads are not blocked by a payment lapse |
| 11 | Share backup link to a Member | `ShareLinkButton` -> `share_links.go` `Create` (7 days, 20 active, revoke, last opened, 3x download cap) -> `SharePage.jsx` | OK. Grouping is by who **started** a backup (`groupByStarter`), so a Member's link carries only what they started plus their private items; a backup they only read needs its own per-backup link. SPEC says so |
| 12 | Phrase setup / check / replace | `PhraseSetupModal`, `RecoveryPhraseCard`, `PhraseReplaceFlow` -> `api/cloud_phrase.rs` | Mostly OK. F-18 (reader changes), F-23 (copy) |
| 13 | Delete a backup | `DELETE /api/v1/backups/{id}` (routes cloud rows to `delete_cloud`) | OK. Cloud: Connect first, local after; drive: retire store, remembered if the drive is away |
| 14 | Deleted user | `api/users.rs` `remove` -> `db::delete_user` | F-01, F-18 |
| 15 | Source moved into/out of a private item | `access::repath_subjects_move` -> `drive_backup::on_moved` -> `check_stop` | Into: OK (stopped, kept). Stopped is final: F-12 |
| 16 | Database loss | Boot `rebuild_from_manifests`, Resume, cloud restore card | F-01, F-02, F-13; legacy cloud restore: section 4 |
| 17 | Factory reset / unbind | `api/search.rs` `factory_reset`, `api/connect.rs` `unbind` | F-11, F-23 |
| 18 | Drive moved to another Luna | Same rebuild path | F-01, F-02, F-13 |
| 19 | Luna replacement | Not built (multi-Luna Phases 1-4) | Phase 0 prerequisites still in the code: section 4 |

## 2. Findings

### F-01 Rebuilt backups, and backups of a deleted creator, can never run again

- **Flow:** database loss, drive from another Luna, deleting the Member who started a shared backup.
- **SPEC says:** a rebuilt backup waits paused and runs after Resume, belonging to whoever resumed it. A shared backup does not depend on its creator's account (section 3, "Deleted user").
- **Code does:** every drive run calls `unreadable_source` (`lunad/backup/drive_backup.rs:442`, defined `:1156`). It loads `created_by` with `db::get_user` and fails the run, hard, with "the person who set up this backup is no longer here" when that user does not exist (`:1162-1172`). `rebuild_one` copies `created_by` and the private owner from the manifest (`drive_backup/ops.rs:321`) and Resume only flips the state (`ops.rs:270`). After a real database loss no user exists, so Resume leads straight to a red failure. The only test (`drive_backup.rs:2004`) keeps the same Admin account, which hides it. Deleting a Member (`api/users.rs:331`, `db.rs:820`) does the same to every shared drive backup they started. Their cloud backups keep working (the cloud path never reads `created_by`).
- **Impact:** after database loss or a drive move the backups cannot be revived, and a deleted Member's shared backups go red with no fix but delete and start over (losing history and the 30-day deleted files).
- **Severity:** broken.
- **Fix:** make `resume` set `created_by` to the resuming person for shared backups, re-attribute a deleted creator's shared backups to the deleting Admin in `delete_user`, and keep the Read check only against the current keeper.

### F-02 Backups are rebuilt from drives once, at boot

- **Flow:** database loss, a drive from another Luna, a drive added later.
- **SPEC says:** the backups come back paused when the drive is added.
- **Code does:** `rebuild_from_manifests` is called once, from `main.rs:658`, and walks drives already in the database. Adopting a drive (`drives/mod.rs` adopt) and hot-plugging trigger nothing; reconcile (`main.rs:131`) runs before it at boot, so a drive already known is fine.
- **Impact:** after database loss the drives are only added after the boot pass, so their backups appear only after the next lunad restart. The same for a moved drive. Nothing tells the person.
- **Severity:** broken for the recovery flows.
- **Fix:** run the rebuild for a drive when it is adopted or mounted, not only at start.

### F-03 Backup notes are never shown

- **Flow:** a run that renames a clashing file, keeps an over-4-GiB file at its old copy, or removes old versions to make room.
- **SPEC says:** nothing is skipped silently; making room is announced.
- **Code does:** lunad stores the notes (`drive_backup.rs:549`, `:627`, `:821`) and returns them as `notes` in both backup lists (`api/backups.rs:398`, `api/cloud_backups.rs:417`). No web code reads `notes` (a search of `web/src` outside the fake finds none).
- **Impact:** files that are not backed up as they are, or older versions removed on a full drive, go unmentioned.
- **Severity:** misleading.
- **Fix:** show the notes under the backup in the shield sheet and Backups folder row.

### F-04 A cloud backup's access list is not refreshed when grants change

- **Flow:** removing a Member's Read on a shared folder, or adding one.
- **SPEC says:** the list is re-saved at once while the source is healthy, so removed access never waits for a run that may be failing.
- **Code does:** `cloud::ops::on_grants_changed` (`backup/cloud/ops.rs:966`) is called only from a test. The four call sites in `api/access/access_admin.rs:320,337,403,437` call the drive version only. The cloud list is re-saved by `record` on a successful run (`ops.rs:825-833`), every 6 hours at best.
- **Impact:** a person whose access was removed can still see the cloud backup in Luna until the next good run, and indefinitely if runs keep failing (full storage, payment lapse). Key readers change at the next run too.
- **Severity:** broken (access lag), small for new access, real for removals.
- **Fix:** call both refreshers from the grant-change sites, and treat a grant change as a reason to start a run.

### F-05 Cloud backups do not keep deleted files for 30 days, and have no frozen clock

- **Flow:** version thinning; a deleted file; a source that is missing for weeks.
- **SPEC says:** both destinations keep a deleted file's last copy for 30 days on a clock that stops while the source is missing.
- **Code does:** the cloud keeps whole snapshots: the newest plus the oldest in each of three age buckets (`backup/cloud/retention.rs:45`, `keep_versions` from `drive_store.rs:486`). A file that lived and died between two retained snapshots is gone at once. Nothing is stored per deleted file. A run that is held (source missing) commits nothing, but when a run later commits, all older snapshots are judged against wall-clock time. After "Back up anyway" on a source that was away more than 31 days, the pre-hold snapshots are all dropped on the next tidy.
- **Impact:** a deleted file is often not restorable from the cloud, against the user's rule; the shield's cloud text (`ProtectSheet.jsx`) quietly leaves deleted files out.
- **Severity:** broken against a fixed decision.
- **Fix:** also retain, for 30 clock-days, the newest snapshot that still contains each file deleted since; keep a per-backup clock that stops while the source is missing, as the drive manifest does.

### F-06 Restoring a deleted folder is refused

- **Flow:** the main reason to restore: the original folder was deleted.
- **SPEC says:** restore needs Write on the nearest folder that still exists, and recreates plain folders (private items are recreated by the owner).
- **Code does:** `restore` requires the destination `mount/source/parent` to already exist (`api/backup_folder.rs:984-994`, `missing_folder` at `:848`). With the source folder deleted, every restore answers "The original folder is missing on X. Put it back, then try again." The "Original is gone" row (`AllBackupsModal.jsx:47` `CopiesLink`) then points the person at the Backups folder where only Download works.
- **Impact:** the person must download and re-upload by hand.
- **Severity:** broken.
- **Fix:** create missing parent folders as plain folders when the person has Write on the nearest existing ancestor.

### F-07 A long first upload looks like a failure and blocks the other backups

- **Flow:** first cloud upload of a large folder; also a big first drive copy.
- **SPEC says:** "First backup in progress" with how much is done, never "failing"; other backups keep running.
- **Code does:** the first run uploads everything and commits one snapshot at the end (`backup/cloud/run.rs`, `copy_and_commit`), so `first_done` stays false for days. The API returns no progress (`api/cloud_backups.rs:392-420`). `status::state` turns a backup with no success for 24 hours into "stale" (`backup/status.rs:11,47`) and any soft error into "failing" after an hour (`:8,43`), and every cloud problem is soft (`ops.rs:832`). The sheet shows "First backup in progress" only while there is no `last_error` (`ProtectSheet.jsx:46`). `cloud::ops::run_all` (`ops.rs:444`, `:453`) and the drive `run_all` (`drive_backup.rs:265`) run backups one after another in a single background task (`main.rs:566-580`, `:679`), so a multi-day first upload also holds up every other backup of that kind, their cleanup sweep and their checks. A retry restarts the read of every file, because the previous-snapshot shortcut needs a committed snapshot. Plan §5's "idle trickle" has no counterpart in the run or the store (no throttle found).
- **Impact:** a healthy first upload reads "Out of date" or "Last backup failed" after a day, with no number to watch.
- **Severity:** misleading, and a real starvation.
- **Fix:** record bytes done and total per run, report them, treat an in-progress first run as OK, and run each backup on its own task.

### F-08 "Waiting" situations are reported as failures

- **Flow:** backup drive unplugged or locked; Luna not linked to Connect; no payment; a Member's first cloud backup before an Admin has a phrase.
- **SPEC says:** "Waiting: <what>", never "failed"; it only needs a look after a day.
- **Code does:** drive: an absent target or source records a soft error (`drive_backup.rs:391-402`, `fail(..., false, ..)`), so after an hour the pill is red "Last copy failed" (`lib/backupRows.js:81`) and the health pill and Needs you count it. Cloud: `NO_ADMIN_PHRASE` (`backup/cloud/run.rs:52,378`), an unplugged or locked source drive (`FilesError` text from `files::drive_root`), and Connect not linked (`NOT_SET_UP`, `ops.rs:25`) are all recorded as soft errors by `record`. Drive backup rows report `paused: "locked"` (`api/backups.rs:364-376`) but cloud rows do not (`api/cloud_backups.rs:392-420`), so a locked source drive makes a cloud backup red while a drive backup says "Paused". A Member's headline is "Not backed up yet" for the first hour, because `backupHeadline` hides the notice while health is OK (`ProtectSheet.jsx:46`, `BackupStatusNotice.jsx`).
- **Impact:** a weekend away with the backup drive, or a new Member backup waiting on an Admin, turns the dashboard red.
- **Severity:** misleading.
- **Fix:** add a "waiting" kind to run outcomes (with its reason), show it with its own pill, and count it as "needs a look" only after 24 hours; send the cloud `paused: locked` flag too.

### F-09 A cloud backup never reaches "Original is gone", and "Back up anyway" is the only way out

- **Flow:** the folder or drive a cloud backup copies is deleted for good.
- **SPEC says:** the backup stays as "Original is gone", stops running, and only Delete removes data.
- **Code does:** only drive backups ever set `source_gone` (`drive_backup.rs:1246`; no cloud code sets it). A cloud run checks the previous snapshot against the folder (`run.rs:211-262`); with most files absent it holds the run with "Most files to back up are missing, or the drive is unplugged" and offers **Back up anyway** (`ProtectSheet.jsx:690`). Pressing it commits a nearly empty snapshot, after which the older snapshots age out under F-05.
- **Impact:** the visible path for a vanished source leads to erasing its cloud copy. Drive and cloud also call the same action two names ("Run anyway", "Back up anyway") with two mechanisms (drive: `hard` error matched by the text prefix "Most of" at `ProtectSheet.jsx:516`; cloud: a `source_missing` flag).
- **Severity:** broken (data-loss path).
- **Fix:** give the cloud the same source-gone and held states as the drive, one name for the action, and never let "anyway" remove copies still inside their 30 days.

### F-10 A forgotten source drive never becomes "Original is gone"

- **Flow:** the source drive is removed from Luna.
- **SPEC says:** "Original is gone".
- **Code does:** `delete_drive_cascade` leaves protections (`db.rs:569`, test at `:3380`). The run's step 3 only sees an unconnected drive (`drive_backup.rs:397-402`) and records "Waiting: Unnamed drive isn't connected." forever (`label_or_default`, `:1132`). Nothing moves it to `source_gone`.
- **Impact:** a permanent red backup that cannot be fixed except by deleting it.
- **Severity:** misleading.
- **Fix:** when a drive row is deleted, mark its backups `source_gone`.

### F-11 Factory reset strands drive backup copies

- **Flow:** factory reset, then adding the same drives again.
- **SPEC says:** copies stay and come back paused when the drive is added again.
- **Code does:** reset removes each drive's marker, which is also the drive's own database (`api/search.rs:411`, `luna-core/src/marker.rs:179`). Re-adoption reuses an existing prefix only if a marker still exists (`drives/mod.rs` adopt, "reuses its existing prefix"); with none it calls `pick_prefix` and takes a fresh uuid. The backup folder is named after the old prefix (`drives/layout.rs:59`), so `list_stores` (`backup/drive_store.rs:457`) and the Backups folder never see it. Side effect, for the crypto and drives reviewers: the drive database with private-item names and albums goes with the marker.
- **Impact:** the copies sit on the backup drive, unreachable in Luna, taking space. The reset text says files are not deleted and does not say this.
- **Severity:** misleading (copies survive, but silently orphaned).
- **Fix:** re-adoption should reuse the prefix found on a drive's `.luna-<uuid>-backups` folder, or reset should say these copies remain on the drive.

### F-12 "Stopped" is final with no way back

- **Flow:** a shared backup's folder is moved into a private item and then out again; any stop reason.
- **SPEC says:** stopped is final; delete it and start a new one.
- **Code does:** `run_inner` refuses unless the state is active or source gone (`drive_backup.rs:362-372`); `create` revives only `source_gone` (`:171`). `PROTECTION_STOPPED` is commented as "set by a person" (`db.rs:1199`) but only the engine sets it (`ops.rs:70-80`). The check is evaluated at move, rebuild and resume only.
- **Impact:** accepted by SPEC, but a stopped backup silently keeps old copies and costs a new backup (history lost) for something a move undid.
- **Severity:** cosmetic against the spec; misleading about who stops it.
- **Fix:** none needed for SPEC; fix the stale comment.

### F-13 Giving away an ownerless private item does not give away its backups

- **Flow:** a drive from another Luna, or database loss, with private items.
- **SPEC says:** private backups are ownerless (Admin-only) until an Admin gives the item away; the new owner then manages and restores them.
- **Code does:** `adopt_ownerless` and `adopt_ownerless_folder` only update the drive's item table (`private.rs:721`, `:750`, `set_owner` `:1182`). The backup row and manifest keep the old `private_owner`. A rebuilt private backup has no Admins entry, so nobody can see it. After adoption `private_stop_reason` (`access_list.rs`) reads "now belongs to someone else" and stops it; `restore` also refuses a mismatched owner (`backup_folder.rs:1018,1041`).
- **Impact:** no one can ever restore or resume a private drive backup that came with a drive.
- **Severity:** broken.
- **Fix:** have adoption also set `private_owner` and `created_by` on the matching protection rows and manifests.

### F-14 The "most of the source is gone" hold differs by destination

- **Flow:** a run after most files vanished.
- **SPEC says:** one rule.
- **Code does:** drive: at least `MASS_DELETE_MIN = 20` deletions and more than half, recorded hard (`drive_backup.rs:26,643-647`, `:497-505`). Cloud: more than half of the previous tree, any size, recorded soft (`run.rs:256-262`, `ops.rs:832`). A folder with 10 files that is emptied is held in the cloud and applied silently on a drive.
- **Severity:** misleading.
- **Fix:** share one rule and one flag (see F-09).

### F-15 A covered child backup keeps its own, different access list

- **Flow:** back up a parent folder after a child already has a backup.
- **SPEC says:** the child shows "Included in the backup of X".
- **Code does:** `covering_protection` (`db.rs:1374`) makes the child stop running (`drive_backup.rs:373-377`, `cloud/ops.rs`). The child's saved list was set when it last ran; the parent's list may exclude a person who is on the child's. That person is told "Included in the backup of X" but cannot see X.
- **Severity:** misleading, low.
- **Fix:** show the cover only to people on the parent's list, or merge lists when a cover starts.

### F-16 Two status vocabularies, and repeated text

- **Flow:** every screen that shows a backup's state.
- **Code does:** the shield sheet headlines are "Out of date", "Last backup failed", "Backed up X ago", "First backup in progress", "Not backed up yet" (`ProtectSheet.jsx:36-48`); everywhere else uses `backupStatus` pills "Last copy failed", "Backup successful", "No copy yet", "Original is missing" (`lib/backupRows.js:81`). A failed drive backup reads "Backup drive X: Waiting: X isn't connected." (`lib/needsYouBackups.js`, `backupDetail`).
- **Severity:** cosmetic.
- **Fix:** one function for both; use the state list in SPEC section 6.

### F-17 Quota full says nothing useful

- **Flow:** the account reaches Connect's cap, or payment lapses.
- **SPEC says:** backups pause, nothing old is deleted, the person is told what to do.
- **Code does:** Connect answers 507 "Your cloud storage is full." (`connect/internal/api/handlers/storage.go`, `storageFull`; cap from `accountBackupCap`, default 2 TB). Luna maps it to `StoreError::Full` (`backup/cloud/store.rs:63,661`) and records the bare sentence as a soft error (`run.rs`). The web has no handling of it. Nothing is deleted (correct). The protect plan's "bigger plan" cannot be true: billing is metered with no plans.
- **Impact:** a red "Last backup failed: Your cloud storage is full." with no action, from an Admin and a Member alike.
- **Severity:** misleading.
- **Fix:** give it its own waiting kind and say "Delete a cloud backup you no longer need, or contact Luna Connect support to raise the limit." Also see F-22.

### F-18 Every reader change re-uploads a whole backup, and deleted users' keys stay listed

- **Flow:** granting or removing Read for a person with a phrase; promoting or demoting an Admin; deleting a user.
- **SPEC says:** the cost is accepted and stated.
- **Code does:** `keys::ensure_key` starts a new version with a fresh dedup key on any reader change (`backup/cloud/keys.rs:272-299`), so the next run uploads the folder again. `db::delete_user_keys` is never called outside tests (`db.rs:1648`), so `publish_users` keeps publishing a deleted user's keys in the signed list (`ops.rs:402-420`).
- **Impact:** adding one Member to a multi-terabyte shared folder starts another multi-week upload and doubles storage until old packs expire; the person is not told.
- **Severity:** misleading (cost), cosmetic (stale keys).
- **Fix:** say so before a grant that will trigger it; drop a deleted user's keys in `delete_user`.

### F-19 The fake lunad does not follow the saved access list

- **Flow:** the state gallery and web tests.
- **Code does:** `visibleTo` in `web/src/dev/fake/handlers/backups.js:45-48` grants a shared backup to Admins, its creator, or anyone with Read on the **live** folder, and a private one to its owner alone. lunad uses the saved list, grant holders on the item for private drive backups, and not the creator (`access_list.rs`, `drive_backup/ops.rs` `visible_to`). `next_check` uses 14 days (`:70`) against lunad's 1 day. The fake cloud run message "Run it anyway to remove the cloud copy too, or stop the backup" (`:249`) offers a stop that does not exist and promotes the F-09 path. The fake restore routes (`dev/fake/handlers/settings.js:101-200`) are legacy.
- **Severity:** misleading for what the gallery proves.
- **Fix:** model the saved list and delete the restore fakes with Phase 0.

### F-20 Drive copies are never verified

- **SPEC says:** copies are compared by size and time only; no promise beyond that.
- **Code does:** `Store::put` compares size and modification time (`drive_store.rs:196-215`); the pill reads "Backup successful". Plan §1's "Luna proves copies are readable" has a cloud sample check only.
- **Severity:** cosmetic against SPEC. Worth deciding whether "Backup successful" overpromises.

### F-21 Some files are skipped without a word

- **Code does:** names that are not valid text and symlinks are skipped (`backup/scope.rs:66`, `:93`); empty folders are not kept; neither is reported. A source's only symlink or non-text name never appears in notes.
- **Severity:** misleading, low.
- **Fix:** count them in a note (F-03).

### F-22 No cloud usage in Luna

- **SPEC says:** Connect shows the total; Luna shows per-backup status. Protect plan §5 says Luna shows Admins the total.
- **Code does:** `CloudStore::usage` exists (`store.rs:196`) but no API or screen in Luna uses it. Connect's `Usage` (`storage.go`) and the Backups page do.
- **Severity:** misleading only if the plan's text is kept; SPEC removes it.

### F-23 Copy implies cloud backups can be brought back through Luna

- **Where:** `ResetLunaCard.jsx:158` ("getting cloud backups back later needs your recovery phrase").
- **SPEC says:** they come back only on the Luna Connect site.
- **Fix:** "You can download your cloud backups on the Luna Connect website with your recovery phrase."
- **Severity:** misleading.

## 3. Checked and fine

Drive create and run ordering, atomic copy and rename, version thinning buckets (`keep_versions`), the deleted-files clock and its 2-hour gap rule, the encrypted-drive pairing rule on create and every run, private walls on create/run/restore/walker, restore never overwrites and avoids hidden private names, saved-list refresh for drive backups, drive and cloud delete ordering, the phrase 409, the phrase check and replacement proof and re-seal, last-Admin guard on demote and remove, share link expiry/revoke/limits, and the "waiting for an Admin" gate for shared backups.

## 4. Dead or legacy backup code the SPEC no longer needs

Per multi-Luna Phase 0, remove (nothing here is needed by SPEC):

- Drive identity copies: `backup/cloud/identity.rs` `copy_to_drive`, `copy_to_drive_at`, `copy_to_drives`, `find_drive_copy`, `drive_luna_ids`, `known_luna_id` (`:84`, `:150`, `:260`, `:277`), `load_or_create_connected`'s drive and Connect lookups, the call sites `drives/mod.rs:661` and `drives/format/run.rs:473`, the `cloud_signing_keys` table (`drives/drive_db.rs:609`), and `net/connect.rs` `list_luna_ids`.
- Store request signing (`backup/cloud/store.rs:423-450`, header `X-Luna-Sig` sent as hex), and Connect `lunaSigValid`, the takeover branch of `authorizeLuna`, `ListLunaIDs` and `GET /storage/luna-ids` (`connect/internal/api/handlers/storage.go:178-243,986`). The hex-versus-base64 mismatch means the takeover has never worked.
- Cloud restore: `api/cloud_restore.rs`, `api/cloud_restore_private.rs`, `backup/cloud/recover.rs`, `backup/cloud/private_recover.rs`, `CloudRestoreCard.jsx`, `PrivateRestoreCard.jsx`, `RestoreForm.jsx`, `lib/cloudRestore.js`, `lib/privateRestore.js`, and the fake restore routes and gallery scenarios.
- `manifest.luna_id` (`backup/drive_store.rs:44`, written in `drive_backup.rs`, `:467-480`, `:755`); nothing reads it.
- `cloud::ops::on_grants_changed` is not dead; it is **uncalled** and should be wired (F-04).
- Smaller: the stale `PROTECTION_STOPPED` comment (`db.rs:1199`); `last_checked_at` on drive rows (drive backups are never checked); the duplicated `has_phrase` check in `api/cloud_backups.rs:97-100` and `ops::check_new_backup`.

## 5. Priorities

1. **F-01 and F-02:** rebuilt backups can never run and are only rebuilt at boot; fixes both recovery flows and the deleted-Member case.
2. **F-13:** private drive backups that arrive with a drive cannot be given to anyone.
3. **F-05:** the cloud does not keep deleted files for 30 days (fixed decision).
4. **F-09:** the only way out for a vanished cloud source erases the copy.
5. **F-06:** restoring a deleted folder is refused, the headline restore case.
6. **F-04:** a removed person keeps seeing a cloud backup until the next good run.
7. **F-08 and F-07:** waiting and first-upload states read as failures, and one long first run starves the rest.
8. **F-11, F-10, F-03:** reset orphans drive copies, forgotten drives stay red, notes are never shown.
9. **F-17, F-14, F-16, F-18:** quota copy, one hold rule, one vocabulary, say what a reader change costs.
10. Phase 0 deletions (section 4) and the fake lunad (F-19), then the remaining cosmetic items.
