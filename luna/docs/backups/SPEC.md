# Luna backups: one shared idea (2026-11-21)

This is the canonical description of what Luna's backup system is, what it does, and what it will never do. It replaces the backup parts of `protect-rebuild/plan.md`, `recovery-phrase/plan.md` and `states-feedback/recovery-phrase.md` wherever they disagree with it (section 12 lists each conflict and how it was settled). It describes the system after multi-Luna Phase 0 (`multi-luna/plan.md`). Behaviour the code has today but this document removes is marked **legacy**. Behaviour this document requires but the code does not yet have is marked **gap**, and `REVIEW-flows.md` has the details. Crypto internals live in the crypto review and the protect plan §5; this document only says how keys and phrases behave.

## 1. What a backup is

- A backup is a standing copy of one **folder or whole drive** (the source) to one **destination**: another Luna drive, or Luna Connect (the cloud). Single files cannot be backed up.
- A backup belongs to **one object and one destination**, from the day it is made until someone deletes the backup itself. A source that moves or is renamed is followed. A source that disappears leaves the backup in place (section 6, "Source gone"). Nothing ever deletes backup data except an explicit delete, the retention rules in section 5, and, in the cloud, an explicit "Back up anyway" on a source that looks gone.
- A backup is **not sharing, not sync and not an archive**. It follows the source: what changes or disappears there is reflected in the backup on the next run, with a short history kept (section 5).
- The shield on any folder or drive is the only way to start, inspect or delete a backup. Each object has at most one drive backup per backup drive and at most one cloud backup. If a bigger folder's backup of the same kind and destination already holds the object, the object shows "Included in the backup of X" and its own backup does not run; it starts again by itself if the bigger one stops or is deleted. A **private** item is never covered by a bigger backup.
- Each backup has a **saved access list**: the people who may see it and take files out of it. It is saved with the backup (drive: in `manifest.json`; cloud: in the sealed key copies) and is refreshed only from a healthy source (section 3).

## 2. Destinations

| | Drive backup | Cloud backup |
|---|---|---|
| Where | `.luna-<uuid>-backups/<backup id>/` on the backup drive: `current/` mirrors the source as plain files readable on any computer, `versions/<time>/` holds earlier copies, `manifest.json` describes the backup | Encrypted packs and signed snapshot records on Luna Connect, under this Luna's cloud identity |
| Runs | Every 30 minutes, and on "Back up now" | Every 6 hours, and on "Back up now" |
| Needs | Read on the source, Write on the backup drive, a different drive from the source. An encrypted source may only go to an encrypted drive. Both drives connected and unlocked | Read on the source, the starter's own recovery phrase, Luna linked to Luna Connect, a payment card on file. A **shared** backup also needs an Admin with a phrase on its list (section 3) |
| Checked | A run compares size and modification time. Copies are not read back (**gap** against "Luna proves copies are readable"; see REVIEW F-20) | A random sample of packs is downloaded and verified every day, and on request. The Backups card shows "copies last tested" |
| Restored from | The Backups folder on the backup drive, inside Luna | The Luna Connect website only |

Cloud storage is billed by use ($8 per terabyte per month). Luna Connect also keeps a per-account safety cap (2 TB by default). When Connect stops accepting uploads because the account is unpaid, or the cap is reached, backups wait and **nothing old is deleted to make room**. Connect shows the stored total; Luna shows only per-backup status.

A drive backup lives entirely on the backup drive: if the drive moves to another Luna, the backup travels with it (section 9).

## 3. Who can do what

| Action | Who |
|---|---|
| See a backup, and download from it | People on its saved access list. For a shared backup: users whose Read covers the **source root** (a member grant on the root or an ancestor), plus the standing **Admins** entry. Never: grants only on a sub-path, upload-only (drop-box) grants, form respond links, guest links. For a **private** item's drive backup: its owner plus people the item is shared with (a member grant on the item itself); no Admins entry. For a private item's **cloud** backup: the owner alone |
| Start a backup | Anyone with Read on the folder, for a drive that also has Write on the backup drive. A whole drive: Admin. A private item, or a folder inside one: its owner only, from their own shield ("Only Sam can back up this item") |
| Run now | Anyone who can see it |
| Run anyway / Back up anyway (see section 6) | Whoever may delete it |
| Resume a backup that was rebuilt from a drive | Whoever may delete it. Resuming makes the resuming person the backup's keeper (**gap**: REVIEW F-01) |
| Delete | An Admin, or the person who started it while the saved list still gives them Read. A private backup: its owner; an Admin only after the owner's account is gone |
| Restore into the original folder | Write on the original folder. A private item's backup: its owner only, into the private item |
| Download from the Luna Connect site | The household's Connect account only (the Admin's sign-in). Members never sign in. Opening anything also needs a recovery phrase that has sealed copies for it |
| Get files back as a Member | The Admin makes a **share backup link** on Connect (one person's backups, or one backup) and sends it to the person who holds that phrase. They type their own phrase on that page, in their browser. The link lasts 7 days and can be turned off. The link alone opens nothing |
| Change a person's recovery phrase | That person, proving the old phrase or their Luna password |

**Saved list behaviour.** A shared backup's list is saved on each good run, and re-saved when a grant changes while the source is healthy, so removed access never waits for a run that may be failing. A missing or failed source never changes it. Once the source is gone the list is frozen. The Admins entry is a role: whoever is Admin now is on every shared backup, including ones whose source is gone. **Gap:** a cloud backup's list is only re-saved on the next good run (REVIEW F-04).

**Private items.** A private item is never inside a parent's backup and never inherits a parent's backup status. Its owner backs it up from its own shield, to a drive or to the cloud. A folder inside a private item is a private backup of its own. Admins never open a private cloud backup, and a private drive backup restores only into its own private item.

**Members and the first cloud backup.** The first phrase on a Luna may be anyone's, but a Member's **shared** cloud backup does not upload until an Admin has a phrase, because only an Admin can open key copies in a disaster. The backup shows "Waiting for an Admin to set up the recovery phrase", not a failure. A Member's own private items do not wait for an Admin.

**Deleted user.** Shared backups they started carry on unchanged and show "Started by a deleted user". Their private backups stay listed as "Private items · deleted user"; an Admin can delete them but never open them. Their keys leave every reader list, which starts a new key version (section 9).

## 4. What is included

- Everything under the source except Luna's own names (`luna_core::marker::extract_prefix` matches the segment, for any drive's UUID: trash, thumbnails, upload parts, other backups, markers, the drive database file) and **private items at any depth**. A user's own `.luna-notes` is included.
- Each form's attachments folder and answers file travel with the form. Albums are exported as data. Favorites are not backed up.
- Files only. Empty folders are not kept. Symlinks and names that are not valid text are not followed (**gap**: they are skipped without a word; REVIEW F-21).
- Adopted from the code, not from the plans: only folders and whole drives can be backed up, and an encrypted drive's files only go to an encrypted backup drive, checked at creation and on every run.
- A file moved **into** a private item stays in the shared backup's earlier versions until normal retention removes them; from the move on only the private item's own backup covers it. A file moved **out** joins the shared backup on the next run.
- Names a backup drive's filesystem cannot hold (case clashes on exFAT or FAT, characters FAT refuses, files over 4 GiB) are stored under a safe name or kept at their old copy, and the backup lists a note for each. **Gap:** no screen shows the notes (REVIEW F-03).

## 5. Versions

- The **latest** version of every file is always kept, and is never thinned.
- Earlier versions: at most three, the oldest copy that is at most 1 day old, the oldest at most 7 days old, and the oldest at most 31 days old ("about 1 day, 1 week and 1 month"). Only files that changed have any. Age is measured from the moment the older copy was replaced.
- **Deleted files** stay restorable for 30 days after the run that noticed the deletion, then are gone. The 30 days are counted on the backup's own clock, which **stops while the source is missing, unreachable or gone**, so an unplugged drive never ages deleted files out. This rule is the same for both destinations. **Gap:** the cloud has no such rule today (REVIEW F-05).
- **Drive:** an updated file's old copy is moved (not copied) into `versions/`. When the backup drive fills up, the oldest versions go first and the run says so in a note; nothing in `current/` is touched. If nothing is left to remove, the backup fails with "<drive> is full".
- **Cloud:** each run commits a whole-folder snapshot. Chunks are shared between snapshots, so only changed data costs storage. Unused packs wait at least 24 hours after being marked before they are deleted.
- When cloud storage is full, uploads pause and no old data is removed.

## 6. Status

A backup's status has two independent parts: its **lifecycle** and, while it is running, its **health**.

**Lifecycle**

| State | Meaning | How it ends |
|---|---|---|
| Active | Runs on schedule | n/a |
| Paused (rebuilt from a drive) | Luna found this backup's `manifest.json` on a drive but has no record of it (database loss, a drive from another Luna, or a drive added later). It does not run until resumed once | Whoever may delete it presses Resume |
| Stopped | The source moved somewhere a backup must not follow. Reasons: "now a private item" or "now inside a private item" (shared backup); "now belongs to someone else", "no longer a private item" (private backup); "now in the trash"; "now on the backup drive itself". The backup and its copies stay | Final. Delete it and start a new one |
| Source gone | The folder was deleted, or its drive left Luna for good. The backup and its copies stay, listed as "Original is gone", and it does not run. If the same path becomes a folder again, it starts again by itself (a restore from trash). The deleted-files clock is frozen. **Gap:** the cloud never reaches this state, and a forgotten drive never does either (REVIEW F-09, F-10) | Delete it, or it revives |

**Health (active backups)**

| State | Meaning |
|---|---|
| OK | The last run finished, or the backup is new and under a day old |
| No copy yet / first backup in progress | Nothing has finished yet. Shows how much is done (**gap**: REVIEW F-07). A first upload that takes days is expected, not a fault |
| Waiting | A prerequisite is missing and a person has to supply it: the source or backup drive is unplugged or locked, Luna is not linked to Luna Connect, there is no payment card, or no Admin has a phrase yet. Shown as "Waiting: <what>", never as "failed". Counts as "needs a look" only once it has lasted a day. **Gap:** today these show as failures (REVIEW F-08) |
| Out of date (stale) | No run has finished in over a day |
| Failing | A run failed for another reason, or the same problem lasted past the grace period (an hour for soft problems; at once for problems a person must fix). The message says what to do |
| Held: most of the source is gone | A run would remove or mark as deleted most of the source, so Luna applies nothing and asks. Drive: at least 20 files and more than half. Cloud: the same rule (**gap**: the cloud has no floor today). "Run anyway" / "Back up anyway" applies it. The drive's copies of deleted files then follow section 5 |
| Check failed (cloud) | The last sample check found a missing or damaged pack |
| Moving to a new phrase (cloud) | Older packs are being re-sealed after a phrase replacement. Not a problem state |
| Cloud paused | Connect is not linked, or has no payment card, or storage is full. Shown on the backup row with what to do |
| Covered | A bigger backup of the same kind and destination holds this one. "Included in the backup of X" |

The Backups card, "See all backups" and Needs you read these same records. Problems show as a status, not as toasts. Toasts only announce actions the person just took.

## 7. Restore paths

1. **Drive backup, inside Luna.** Open the Backups folder at the root of the backup drive. It lists each backup on that drive that the person may see: name, where it came from, status, last good copy, size. Inside, browse `current` or pick an earlier version, then:
   - **Download** a file, or a folder as a zip.
   - **Restore to original folder.** Never overwrites. If a name is taken, the copy is named `<name> (restored 16 Oct)`, then `… 2`. Names are also checked against hidden private items. Restore needs Write on the original folder, or on the nearest parent that still exists when the original folder was deleted; missing folders are recreated as plain folders. A private item's backup restores into that private item only, by its owner; if the item itself is gone, the owner makes it again first. A restore is disabled, with the reason, when the original drive is not connected.
   - **Gap:** restoring a deleted folder is refused today (REVIEW F-06).
2. **Cloud backup, Luna Connect only.** An Admin signs in to the household account, types a recovery phrase, and downloads files or folders (a zip for folders) from any version. The phrase opens exactly what it has sealed copies for: the shared backups on that user's saved lists plus that user's private items. A Member gets files through a share backup link (section 3). **There is no restore from the cloud inside Luna.** The one exception is the one-time **Bring back files** copy onto a replacement Luna (section 9), which this document records as a designed carve-out that needs the owner's confirmation, because it would put cloud-to-Luna copying inside Luna.
3. **Same name, same place.** Nothing a restore does ever overwrites a file.
4. **From another computer.** A drive backup's `current/` and `versions/` are plain files. Anyone can plug the backup drive into another computer and copy them. Cloud copies cannot be read without a phrase.

## 8. Phrase and key lifecycle (behaviour)

- A recovery phrase opens a person's **cloud** backups. Drive backups never need one.
- **Setup.** There is no setup step and nothing asks at sign-up. The phrase is asked for the first time a person turns on a cloud backup or opens Settings → Cloud backup (shown to everyone; with Connect off it shows the card and a note). It is made in the browser, shown with Print and Download, and confirmed by typing three random positions while still on screen. Luna never sees the phrase or any word of it. A cloud backup cannot be created without one (a 409 `needs_phrase`; the shield opens the phrase dialog first).
- **Check.** Every 90 days Luna asks the person to type the phrase; the browser proves it by signing a challenge. Nothing secret leaves the browser. A check never changes keys.
- **Replace.** Two independent questions: do you still have it (decides the proof: old phrase, or your Luna password), and could someone else have it. Every shared key version the person is on is re-sealed to the new phrase. If nobody else could have it, nothing uploads again. If someone might, a new key version starts for new data, old packs move to it in the background, and private history moves with the phrase when the old phrase is available. A lost phrase loses private history only (kept 30 days unless someone might have it). Replacing the last Admin's phrase is allowed; demoting or removing the last Admin who has a phrase is refused while cloud backups exist.
- **Readers.** A shared backup is sealed to every person on its saved list who has a phrase, Admins included. Any change to that group (someone added, removed, deleted, demoted, promoted) starts a **new key version with a fresh dedup key**, so the next run uploads the whole folder again. Someone added gets only what is backed up from then on; someone removed cannot open anything backed up after, but what they could open before cannot be taken back. A cost to say plainly: every such change re-uploads the whole backup.
- **Private items** are sealed to the owner alone. Not Luna, not an Admin, not us.
- **Identity.** Each Luna has one cloud identity (id plus signing key) minted by Luna at first cloud setup, held only in Luna's system database. It never moves between Lunas or devices and is never copied to a drive (**legacy today**: drives carry copies; removed in Phase 0).
- A removed Admin's older retained copies can become unopenable by others; the guard only covers new versions.

## 9. What happens when…

- **A drive is missing.** A backup whose backup drive is unplugged or locked waits (section 6); nothing is deleted. A missing drive is never read as an empty folder: a run first needs the drive's marker present. If the **source** drive is missing, the deleted-files clock freezes. A run that would delete most of the source is held (section 6).
- **The source is gone.** The backup stays as "Original is gone" and stops running. Only Delete removes data. To get files back from a gone source, restore (section 7) recreates the folder.
- **The source moves.** The backup follows moves and renames, including to another drive. If it lands inside a private item, or on the backup drive itself, the backup stops and says why (section 6).
- **Luna's database is lost.** Accounts are gone, so Luna is set up again with a new Admin. The new Luna mints a **new** cloud identity. Old cloud backups stay on Connect under the same Luna entry as "Backups from before <date>", downloadable there with the phrase; nothing in Luna brings them back (**legacy today**: `CloudRestoreCard` and its API do). Drive backups come back from each drive's `manifest.json` when the drive is added, **paused**; an Admin resumes shared ones (they become that Admin's), and private ones wait for an Admin to give the private item to a person. Cloud backups are started again; the first upload repeats.
- **Factory reset.** Everything in Luna's database goes, including accounts, keys and the cloud identity. Files on drives stay. Drive backup copies stay on the backup drive and come back paused when that drive is added again (**gap**: REVIEW F-11). Cloud copies stay on Connect while payment is on. The reset flow asks whether to unbind Luna Connect, and says cloud backups can be downloaded on the Connect site with the phrase.
- **Unbind from Luna Connect.** Cloud backups stop running and say why. Luna keeps its rows and identity; linking the same device again continues them. Linking a different device (a different Connect Luna entry) starts a new identity and leaves the old copies under their entry. Paid copies stay while payment is on.
- **A drive moves to another Luna.** The drive carries its backups' manifests. User ids in them match nobody on the new Luna, so shared backups are Admin-only (the Admins entry) and private ones are ownerless until an Admin gives the private item to a person. They come back paused. **Gap:** a rebuilt backup can never resume today (REVIEW F-01, F-02).
- **Luna replacement (multi-Luna plan).** Identities never move; data is copied. The replacement Luna is added to the same Connect account with its own subscription. It backs up again under its own identity. The old Luna's cloud backups remain downloadable on Connect until deleted. The replacement Luna can run **Bring back files** with the person's phrase to copy files from the old Luna's backups onto its drives (never overwriting), and offer to back those folders up again, paused until confirmed. Version history does not move. The old backup is offered for deletion once the new first backup has finished. Phase 0 (removing drive identity rebuild) is a prerequisite; Bring back files is Phase 4.
- **A target drive is full.** Drive: oldest versions go first, with a note. Cloud: uploads pause.
- **Delete a backup.** Drive: the row goes at once; the copies are removed now or the next time the drive is connected (a leftover store is never mistaken for a live backup). Cloud: the copies and key records are removed from Connect first; if Connect cannot be reached, nothing is removed and the person retries. Packs follow the 24-hour wait. "Delete" says what goes: every saved copy and every earlier version; the original files stay.

## 10. Schedules and limits

Drive backups run every 30 minutes; cloud backups every 6 hours; cloud checks daily on a small random sample; the phrase check is due every 90 days. Runs of one backup never overlap, and a run, restore, delete or key move holds the backup while it works. A first copy that takes hours or days must not stop other backups (**gap**: REVIEW F-07).

## 11. Not supported, by design

- Restoring a cloud backup **inside Luna**. Cloud copies come back only on the Luna Connect website. (Only exception: the replacement-Luna Bring back files copy, section 9.)
- **Members signing in to Connect.** They get files from an Admin's share backup link.
- **History beyond** the latest plus about one day, one week and one month of earlier versions, and deleted files beyond 30 days.
- A private item **inheriting** a parent's backup, being inside a parent's backup, or showing a parent's backup status.
- **Admins opening** a private cloud backup, or restoring a private drive backup.
- **Moving a cloud identity between Lunas or devices.** Data is copied, never the identity.
- **Overwriting** an existing file on restore.
- Backing up **single files**.
- **Deleting old cloud data to make room** when storage is full.
- **Nudges** to back up an item that has no backup. The shield and the Backups card only talk about backups that exist.
- Backing up **favorites**.
- Backing up an encrypted drive to a plain one.
- A backup on the **same drive** as its source.
- Per-person cloud usage, or showing an Admin anything about a private backup beyond one combined status.
- Verifying a drive backup beyond size and time (not a promise).

## 12. Conflicts between documents, and how they were settled

The user's fixed decisions are: private items never inherit and are never inside a parent's backup; cloud restore only on Connect; Members never sign in to Connect; the version rule; and cloud backups belonging to one Luna with identity never moving.

1. **Database-loss recovery.** Protect plan §5 ("Luna loses its database", signing key copies on drives, "binding again … reattaches the backups") against multi-Luna §3.3. **Multi-Luna wins.** Database loss gives a new identity; the restore cards are legacy.
2. **Luna restore card** (Protect plan §6, STATUS phase 3) against "restore only on Connect". **The fixed decision wins**; the restore cards and APIs are legacy.
3. **Bring back files** (multi-Luna §7) against "no restore from the cloud inside Luna". The plan is a replacement-Luna data copy, so it is kept as a recorded carve-out and flagged for the owner (section 7, point 2).
4. **Private restore when the item is gone.** Protect plan §4 recreates it with `private::create`; the code makes the owner recreate the item. **The code's stricter rule is adopted**: no private item is made up on a restore.
5. **Admin deleting a private backup.** Protect plan §2 says an Admin can delete one; §7 and the code allow it only once the owner is gone. **The code is adopted.**
6. **Source gone.** Protect plan says it stops running; the code retries each run and revives if the path comes back. **The code is adopted.**
7. **Dedup key on a reader change.** Protect §5 says re-wrap; the 2026-10-17 decision says a fresh key; recovery-phrase §4 keeps it for an exposed phrase replacement. All three stand, each for its case (section 8).
8. **Removed person's copies.** Protect §5 deletes their sealed copies and share links; the later recovery-phrase decision and the code keep copies of the versions they were on. **Later decision adopted.**
9. **Last Admin and phrase replacement.** Protect §5 step 7 blocks it; recovery-phrase decision 1 allows it. **Allowed**, demote and remove stay guarded.
10. **Phrase timing.** Protect §5 and the first recovery-phrase doc make it a setup step; 2 Nov 2026 removed it. **Asked at the first cloud backup.**
11. **Where the phrase card lives.** `luna/AGENTS.md` (External services), the recovery-phrase plan §2, and states-feedback differ. **The code is adopted:** Settings → Cloud backup for everyone, Luna Connect separately.
12. **Cloud checks.** Protect plan says weekly; the code checks daily. **Daily is adopted.**
13. **Backup problems on the dashboard.** Protect plan §8 keeps them out of Needs you; the code lists them there too. **The code is adopted**; the UX is settled.
14. **Factory reset and drive key copies.** Protect plan says the copies go with the marker; multi-Luna §1 says they stay. Moot after Phase 0, which removes the copies.
15. **Cloud deleted files.** Protect plan §3 promises 30 days for both destinations; the code gives the cloud none. **The plan and the fixed decision win** (gap, section 5).
16. **Cloud usage.** Protect plan §5 says Admins see total usage in Luna. **Connect shows it; Luna does not** (section 2).
17. **Quota wording.** Protect plan says "free space or a bigger plan". There are no plans (metered), so the copy never offers one.
