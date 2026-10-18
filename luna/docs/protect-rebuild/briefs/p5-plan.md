# Phase 5 plan: Backups card, See all backups, health checks, phrase reminders, companions

Plan: `/var/home/plainskill/.claude/plans/protect-rebuild.md` §7, §8, §9 (companion naming), §5 Checks. Starts after phase 4 is reviewed and committed (it reads phase 4's JSON: `private`, `old_phrase_copies`, `/api/v1/private-backups/*`).
Every implementer reads `brief-common.md`; web tasks also `brief-web.md` and `AGENTS.md` (Plain language, Frontend, Design, Haptics).

## What already exists (do not re-plan)
- `components/dashboard/BackupsCard.jsx` and `AllBackupsModal.jsx` (drive rows only), mounted in `pages/DashboardPage.jsx` ~770, with tests.
- `system/system_health.rs::backup_checks` (drive rows only), `backup/status.rs` rules (`state`, `ago`).
- `RecoveryPhraseCheck.jsx` (`{lunaId, onClose, onVerified, title, intro, submitLabel}`) and `POST /api/v1/cloud/phrase/check` (sets `last_checked_at`).
- The dashboard "Needs a look" card shows failed drives only, so backup problems already stay out of it (T7 verifies).
- Desktop and Android call no backup routes (grep: desktop uses auth, device-tokens, drives, health, uploads). Only their copy needs work (§9).

## Waves

| Wave | Tasks (parallel inside a wave) | Needs |
|---|---|---|
| 0 | **T1** Rust: `check_due` on the phrase status; cloud + private branches in `backup_checks`. **T2** Desktop + Android copy: their upload features stop saying "Backup". **T3** Files: "Not backed up" shield on your own private folders; open a drive's Backups folder from `?backups=1` | phase 4 done |
| 1 | **T4** `lib/backupRows.js`: one place for row helpers, cloud-aware; the two dashboard components switch their imports only | T1 (field names) |
| 2 | **T5** BackupsCard: cloud rows, tested line, phrase reminder. **T6** AllBackupsModal: Cloud chip, Private items rows, source-gone links | T4 (both), T3 (T6 link target) |
| 3 | **T7** Cross-check: every web fetch against a backend route and its JSON fields; toast audit | all |

7 tasks in 4 waves. Phase 5 is small: most of it exists.

### File ownership
- `api/cloud_phrase.rs`, `system/system_health.rs`: T1.
- `luna/mobile/app/src/main/res/values/strings.xml` (+ any Kotlin literal it finds), `luna/desktop/src/ui/*.rs`: T2.
- `components/files/DriveFileExplorer.jsx`, `components/files/ProtectSheet.jsx` (`ProtectButton` only), `components/files/FileRow.jsx` if needed: T3.
- New `lib/backupRows.js` (+ test): T4. `BackupsCard.jsx`, `AllBackupsModal.jsx`: T4 (imports only) → T5 / T6. Tests of each component go with it.
- T7 edits nothing unless the orchestrator approves a fix; it writes its table into its report.

## Decisions taken in this plan (tell the user)
1. **Phrase check reminder after 90 days.** "Check your recovery phrase" shows on the Backups card when the person has a phrase, can see at least one cloud backup, and their last check (or the setting of the phrase) is 90 or more days ago.
2. **"Copies last tested"** is the newest `last_checked_at` over the cloud backups the person can see; drive backups have no test step. Without cloud backups the line reads `N backups`.
3. **Private items in health checks** are one check per owner, named by owner, never by item: "Max's private items are backed up." / "1 of Max's private items needs a look. Max can see why."
4. **Companion names (§9):** Android's photo feature becomes "Photo upload" (`Upload now`, `Upload automatically`, …); the desktop's folder feature becomes "Folder upload" (`New folder upload`, …). Their behaviour and code names stay.
5. **Source-gone rows** in See all backups link to the target drive's Backups folder (`/drives/<target>?backups=1`) for drive backups and to `https://connect.luna.libreloom.org/backups` for cloud ones.

## Shared contracts
- `GET /api/v1/cloud/phrase` gains `"check_due": bool` (T1). Rule: `set && now - max(phrase_set_at, last_checked_at) >= 90 * 86400`.
- Health check names: drive `drive_backup_{id}` (as today), cloud `cloud_backup_{id}`, private `private_backups_{owner_id}`; category `"backups"`. Private rows are left out of the per-row loops.
- Row model for the web (T4, `lib/backupRows.js`), built from `/api/v1/backups` + `/api/v1/cloud/backups` JSON:
  ```js
  /** @typedef {{ id, kind: "drive"|"cloud", private: boolean, source_drive, source_path, source_name,
   *   destination: string,            // target_drive_name, or "Cloud"
   *   status, state, last_ok_at, last_error, stop_reason, created_by, last_checked_at?, check_problem? }} BackupRow */
  export function buildBackupRows(driveList = [], cloudList = [])  // both kinds, private rows included, sorted by urgency
  export function needsALook(row)          // drive: as today; cloud: also check_problem or source_missing
  export function backupStatus(row)        // {label, variant} as today
  export function sortByUrgency(rows)
  export function lastGoodCopyLine(row, now = Date.now())
  export function backupHeadline(rows)
  export function lastTestedLine(rows, now = Date.now()) // "9 backups · copies last tested 2 days ago" or "9 backups"
  export function creatorName(userId, users)
  export function groupByCreator(rows, users)            // as today
  export function privateGroups(summary, users)          // summary.owners → [{ownerId, name, deleted, backups, needsLook}]
  ```
- `/api/v1/private-backups/summary` and `/mine` as in `p4-plan.md`.

## Reviewer checklist (Opus, after wave 3)
1. T7's table: every `getJson/postJson/fetch` URL in the touched web files has a matching `.route(` (lunad) or `r.Get/Post/...` (Connect), and every JSON field read exists in the handler.
2. No toast in BackupsCard / AllBackupsModal except for user actions; failures show inline.
3. Health page: no private item path or name in any check message (`grep -n "private" system_health.rs` + its tests).
4. Android and desktop: no user-facing "Backup" left for the upload features (`grep -rn -i "back ?up" luna/mobile/app/src/main/res luna/desktop/src/ui`); code identifiers unchanged.
5. `npm run scan:colors`, lint, typecheck, vitest for luna/web; cargo tests for lunad; gradle unit tests; desktop cargo test.
