# Luna and Luna Connect product cohesion audit

Reviewed 2026-11-14 against checkout `39e37e30`. This is a source audit, not a live acceptance test. Findings below follow reachable UI actions through their implementation. No product code was changed, and no test suites, live payments, or destructive operations were run.

Report validation: `git diff --check` passed. The repository-required `./ci check -r` completed with 19 static checks passed, zero failures and zero skips. These checks do not reproduce the user journeys described below.

Scope: Luna web and daemon, Connect web and device/retention handlers, Android pairing and photo uploads, and desktop pairing, settings, uploads and sync. This is a targeted journey review, not an exhaustive certification. Connect's separate visual system is intentional and is not a finding.

## Findings

### 1. High — Disconnecting Luna starts a deletion deadline the confirmation does not disclose

**Journey:** In Connect → Devices, choose **Unbind Luna** with cloud backups stored. The confirmation says: “Cloud backups stay on this account and stay billed until you turn off payment in Cloud backups.” The server instead marks the device's cloud identities for deletion after 30 days. The retention worker enforces that deadline independently of turning payment off.

The Luna-side route is even less explicit: Settings → About → Advanced → **Remove device token** executes immediately. Its only explanation is that it disables Luna Connect. This calls `deactivate`, which calls Connect's unregister endpoint and reaches the same unbind/deletion policy when Connect is reachable. If Connect is unreachable, local removal still succeeds, so remote unlinking and retention state can differ from what the user expects.

**Evidence:**

- `connect/web/src/pages/LunaPage.jsx:352` — unbind confirmation.
- `connect/internal/api/handlers/device.go:126-139` — unbind sets `purge_after`; `:349-356` — local unregister uses the same operation.
- `connect/internal/api/handlers/retention.go:187-207` — deletes due unlinked storage.
- `web/src/components/settings/ConnectDeviceCodeForm.jsx:93,150` — limited explanation and immediate mutation.
- `crates/lunad/src/net/connect.rs:692-710` — best-effort unregister followed by local token removal.

**Impact:** A person can deliberately leave payment enabled believing that preserves their backups, yet lose them after 30 days. Turning off a local connectivity feature also has an undisclosed cloud-data consequence.

**Recommendation:** Give both entry points the same explicit retention explanation and confirmation: public access stops, uploads stop, stored copies are deleted after 30 days unless relinked, and billing continues while storage remains. Distinguish successful local disablement from confirmed cloud unlinking. The Backups page already displays a deletion date after unlinking (`connect/web/src/pages/BackupsPage.jsx`, `unpairedNote`); the warning belongs before the decision too.

### 2. High — Reset does not warn about losing local backup keys or the recovery prerequisites

**Journey:** Reset an existing Luna with cloud backups. The confirmation emphasizes that drive files are not deleted and remote access turns off. It neither prompts users to preserve their recovery phrases nor explains that the backup catalog and keys are removed.

**Evidence:**

- `web/src/components/settings/categories/ResetLunaCard.jsx:42,59` — descriptions shown before reset.
- `crates/lunad/src/api/search.rs:299-319` — deactivates Connect and resets the database.
- `crates/lunad/src/db.rs:594-625` — deletes protections, cloud identity, user keys, backup keys and snapshot metadata.
- `crates/lunad/src/api/cloud_restore.rs:1-6` — restoring the backup catalog requires the browser to open sealed key copies with the recovery phrase.
- `web/src/components/cloud/CloudRestoreCard.jsx:130-149` — recovery requires the signing identity and phrase; may require reconnecting original drives.

**Impact:** “Files stay” is true of the original drive bytes but is not sufficient to make an informed reset decision. People can discard the only locally available keys before realizing they need their saved phrases to recover cloud copies. Reset also invokes the cloud-unlink policy in finding 1.

**Recommendation:** Before reset, explain that backup jobs stop and saved backup keys/catalogs are removed. Prompt every affected person to preserve their recovery phrase, and explain the cloud retention deadline and relinking step. Do not imply reset itself erases original drive files or immediately deletes cloud objects.

### 3. High — Android cannot reliably resume a partially completed photo batch

**Journey:** Upload two photos. Let the first finish, then interrupt the second with a network failure or worker cancellation. Retry.

The worker only saves its progress marker after the entire image/video batch finishes. The retry selects the first photo again. Android supplies no conflict policy or existing-file identity check; current lunad rejects that name with HTTP 409. The retry therefore stops before reaching the unfinished photo. Different source items with the same filename in the same month can cause the same blockage.

**Evidence:**

- `mobile/app/src/main/java/net/plainskill/luna/PhotoBackupWorker.kt:46-48,83-86,100-122` — selection, uploads, and end-of-batch checkpoint.
- `mobile/app/src/main/java/net/plainskill/luna/LunaApi.kt:266-273,305-320` — creates and completes uploads without conflict handling.
- `crates/lunad/src/api/uploads.rs:77-86` — an existing name without `on_conflict` is rejected before transfer.

**Impact:** Ordinary interruptions can leave automatic photo upload stuck on an already successful file. This is a concrete client/server behavior mismatch even though both advertise API version 1.

**Recommendation:** Track successful media items durably per destination and make retries idempotent. Resolve filename collisions without silently overwriting another photo. A single timestamp updated after each image is insufficient because images and videos are scanned separately and multiple items can share a timestamp.

### 4. High — Changing Android's destination silently excludes photos already copied elsewhere

**Journey:** Finish uploading photos to drive A, then use Settings → Choose folder to select an empty folder on drive B. Run upload again.

**Evidence:**

- `mobile/app/src/main/java/net/plainskill/luna/SettingsFragment.kt:17-29` — saves the new destination and schedules work.
- `mobile/app/src/main/java/net/plainskill/luna/BackupPrefs.kt:98-104` — destination setters preserve `last_backup_at`.
- `mobile/app/src/main/java/net/plainskill/luna/PhotoBackupWorker.kt:46,100-119` — only selects media newer than that retained marker.

**Impact:** The newly selected destination never receives the earlier photos. The UI checks that the destination is writable, but gives no choice or warning about leaving the old collection behind. A replacement drive can look configured while containing only future uploads.

**Recommendation:** Scope upload history to the Luna, drive and folder. On destination change, explicitly offer to copy the existing library or start with new items, with the consequence stated before saving. Handle any in-flight job against the old destination as part of that change.

### 5. Medium — A failed cloud backup listing is displayed as an empty backup collection

**Journey:** Open Luna → Settings → Luna Connect while the initial `/api/v1/cloud/backups` request fails.

**Evidence:** `web/src/components/settings/categories/CloudBackupCategory.jsx:155-164,276-285` defaults absent query data to `[]`, then displays “Nothing is backed up to the cloud yet.” It does not branch on the listing query's loading or error state. Its separate `error` state covers mutations, not this request.

**Impact:** A connectivity/server failure is presented as a statement about whether backups exist. This is especially misleading during recovery or when someone is checking whether files are safe.

**Recommendation:** Show separate loading, failed-with-retry, and successfully-empty states. Never infer absence of backups from absent query data.

### 6. Medium — The cloud recovery entry point disappears when its status check fails

**Journey:** After losing the local backup catalog, open Luna Connect settings while the restore-status request fails.

**Evidence:** `web/src/components/cloud/CloudRestoreCard.jsx:116-117` returns nothing on `restore.isError`. The adjacent private-item recovery card already provides an explicit warning and retry on the equivalent failure (`web/src/components/cloud/PrivateRestoreCard.jsx:79-96`).

**Impact:** The user cannot distinguish “nothing to recover” from “Luna could not check.” The recovery action disappears precisely when connectivity or server problems may require guidance.

**Recommendation:** Follow the private-item recovery card's error/retry pattern, retaining a visible recovery entry point and explaining what could not be checked.

### 7. Medium — Android's “Last upload” is actually the newest media item's import date

**Journey:** Upload an old photo library today, then inspect the Backup screen. A successful upload can appear to have happened months ago.

**Evidence:**

- `mobile/app/src/main/java/net/plainskill/luna/PhotoBackupWorker.kt:86,98,112,122` stores the maximum MediaStore `DATE_ADDED` as `last_backup_at`.
- `mobile/app/src/main/java/net/plainskill/luna/BackupFragment.kt:51-55` formats that value as “Last upload.”

**Impact:** The displayed freshness signal does not describe when the upload ran. People cannot use it to assess whether automatic uploads are working.

**Recommendation:** Store last successful upload/check time separately from the media selection cursor; label each according to what it measures.

## Checks that did not become findings

- The drive encryption sheet already states that protection erases the drive, warns that a forgotten password cannot be recovered, and hands off to the erase-preview flow. See `web/src/components/drives/DriveEncryptionSheet.jsx:141-147,179-184,235` and its existing tests. The example omission is not present in this checkout.
- Android, desktop and lunad all currently declare API version 1 and implement a compatibility check. There is no basis for calling the whole Android app obsolete solely from its version. Finding 3 demonstrates a behavioral mismatch that those version checks do not catch.
- Web pairing produces the URL/token payload that Android parses. The QR explicitly says it contains the current browser address. This source review did not establish automatic LAN/public-address switching or test Android networking on a real phone.
- Desktop has explicit upload overwrite handling and conflict-copy behavior, unlike Android's unconditional create-only photo flow. Its remote-deletion handling moves local files aside into a hidden trash directory. Those observations are not a full desktop sync correctness assessment.

## Suggested order

Fix the disconnect/reset warnings first because they affect irreversible decisions. Then address Android upload idempotency and destination-specific history together. Finally make backup loading, freshness and recovery states consistent across surfaces. Keep Connect's purposeful account/billing boundary, but make the consequences of crossing it explicit in Luna.
