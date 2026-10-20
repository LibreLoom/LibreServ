# Protect rebuild — plan for review (2026-10-16)

Status: draft, not started. Replaces today's Protect (local copies) and cloud backup entirely.

## 1. Principles
- **Object-based, bound forever.** A backup belongs to one protected object (a folder or a drive) and stays listed until someone deletes the backup itself. No orphans.
- **The shield stays the entry point.** Any folder or drive → shield → "Back up to the cloud" (only if Connect is set up) / "Back up to another drive" (only if another drive is attached).
- **A backup never crosses into a private item.** Private items are backed up only by their owner, from their own shield. Items never change privacy state; only moves cross the boundary.
- **Where you download from:** drive backups only from that drive's **Backups** folder in Luna. Cloud backups only from the **Connect web UI**. There is no "restore onto a new Luna".
- **Reassurance is part of the feature:** every backup shows its state, and Luna proves copies are readable.

## 2. Core model
`protections` (Luna system DB, rebuilt):
- `id` (minted at creation, never reused), `kind` (`drive` | `cloud`), `source_drive`, `source_path`, `private_owner` (user id, or null), `created_by`, `created_at`, `target_drive` (drive kind only), status fields (`last_ok_at`, `failing_since`, `last_error`, `hard`, `last_checked_at`).
- The path follows moves and renames the way grants do (`access::repath_subjects_move`), including moves to another drive. A cross-drive move gives a private item a new id and the new drive's prefix (`jobs.rs`), so the protection must be moved in the same step, never matched by item id.
- Downloads never write `.luna-` names back onto a drive: a carried store keeps its source drive's UUID and would be invisible elsewhere.
- On every repath, check `private::boundary_for`: a source moved **into** a private item, or onto its own target drive, stops its backup and shows "Stopped: this folder is now inside a private item" / "…now on the backup drive itself". The backup is kept.
- **Source gone** (deleted, or drive missing for good): the backup is kept and listed as "Source gone"; it stops running. Only "Delete this backup" removes data.
- **A missing drive is not an empty folder.** Before any run, the source drive's marker must be present (an unmounted drive leaves an empty mount point). A run that would mark most of the source as deleted is held and shown as a problem instead of applied. While the source is missing, unreachable or gone, the deleted-files clock (§3) is frozen.
- **A drive moved to another Luna:** user ids in its manifests match nobody there. Its backups follow the ownerless-items rule (`private.rs` `ownerless`/`adopt_ownerless`): Admin-only until an Admin gives them away.

Who can do what:
- Back up a folder: anyone with Read on it, since a backup changes nothing and Read can already download it all. Permission is about the destination: a drive backup also needs Write on the target drive; a cloud backup needs your recovery phrase set up. A whole drive: Admin. A private item: its owner only, even if it's shared with others. They get the drive backup through the saved access list, but cloud copies are sealed to the owner alone. Their shield sheet says "Only <owner> can back up this item."
- One backup per object per destination. If one already exists, the shield shows it and its status instead of starting another.
- **The access list** = users whose Read covers the **source root** (a grant on the root or an ancestor), plus, for shared backups only, a standing **Admins** entry. Never: grants only on a sub-path inside the source, upload-only (drop-box) grants, form respond links, or guest links (`access_links`). Guest links never see the Backups folder either.
- The **Admins** entry is a role, not a frozen list of people: whoever is Admin now is on every **shared** backup, including ones whose source is gone. It never applies to a private item's backup: there an Admin can only delete, except through the ownerless-items rule. Someone already on a frozen list who sets up a phrase later gets a sealed copy; that isn't an edit.
- Seeing a backup follows the access list saved with it, not the live source. Each successful run saves the source's current grants (drive manifest / cloud snapshot). A grant change on a healthy source also re-saves the list right away (so removed access doesn't wait for a run that may be failing). A missing or failed source never changes it. So if a drive dies, everyone with access at the last good run keeps it. Access removed on a healthy source carries over at the next run. Once the source is gone the list is frozen and nobody edits it.
- Delete a backup: an Admin, or the person who started it while the saved list still gives them Read. Private backups: the owner only (an Admin can delete one but never open it — see §7).

What's included:
- Everything under the source except private items (at any depth) and Luna's own stores. Rules (from the code audit):
  - Judge only path segments **below** the source root (`is_internal_temp` checks every segment and would skip all of a private item's own backup, whose root is a `.luna-` name).
  - A segment is Luna's when `luna_core::marker::extract_prefix` matches it, for any drive's UUID (a drive can carry several markers). Never a bare `starts_with(".luna-")` (drops a user's `.luna-notes`), never this drive's prefix only, never `is_protected_store` (first segment only). This also stops A→B / B→A backups of backups.
  - Skipped: trash (also needed for privacy: private-folder deletions land there under real names), thumbs, upload `.part` files, marker temp files, the drive DB file itself (live, carries the drive's identity).
  - **Carried with their form:** each form's `{p}-form-<hash>` files folder (attachments to answers) and answers file, as `jobs.rs` does for copies. A private form's companions sit *beside* the private item, so they go only into the owner's backup, never a shared one.
  - Private items are identified by the `private_items` table, not by name shape.
  - Albums (drive DB, not rebuildable) are exported as data in the backup, not copied as the raw database file. Favorites are not backed up.
  - The walker (`backup/scope.rs`) uses its own segment rule below the source root; the file browser's `is_internal_temp` is unchanged.
  - The drive marker *is* the drive DB file `.luna-<uuid>.sqlite3` (`marker.rs:69`): "marker present" (§2 missing-drive guard) and "skip the drive DB" refer to the same file.
- A file moved **into** a private folder: its earlier versions stay in the shared backup; from the move on, only the private folder's backup covers it. A file moved **out of** one joins the shared backup on the next run.
- Nested private items: each one is its own backup, even inside the owner's other private folder.

## 3. Versions and retention (both destinations)
- Latest version always, plus at most 3 earlier ones: about 1 day, 1 week and 1 month old. Only files that changed have any. Deleted files: 30 days, then gone (clock frozen while the source is missing or gone, §2).
- Cloud versions cost only changed chunks. Drive versions are full copies unless the filesystem shares blocks (reflink), so the short history matters most there.
- The latest version is never thinned. When the target fills up, the oldest versions go first, with a warning, never silently.

## 4. Drive backups
Storage on the target drive, under Luna's namespace: `.luna-<uuid>-backups/<protection-id>/`
- `current/`: plain files mirroring the source, readable on any computer.
- `versions/<timestamp>/`: earlier copies of changed or deleted files only. Saving a version **moves** the old file there (free), then the new one is written temp-file-then-rename (`copy_atomic`). Never hardlink and write in place: that would change the saved version too.
- **Target filesystems** (`fsprobe.rs`): on exFAT/FAT, names differing only in case (`a` / `A`) would overwrite each other, so the second is stored with a suffix and reported; files over 4 GiB can't go on FAT and are reported by name. Nothing is skipped silently.
- The Backups folder lives under a `.luna-` name, which the file API seals, so it gets an API alias the way Trash does (`real_rel`, `files/mod.rs`).
- `manifest.json`: protection id, source description, owner, grants at the last run, run history. The drive describes itself, so it works if the drive moves to another Luna or the system DB is lost.

**Backups folder** (like Trash, at the drive root in Luna's file browser):
- Lists each backup stored on this drive: name, where it came from, status pill, last good copy, size.
- Who sees what: the access list in its manifest (§2). For a private item's backup that list is the owner plus the people it's shared with.
- Inside: browse `current`, pick a date for an earlier version, then:
  - **Download** (a file, or a folder as a zip).
  - **Restore to original folder.** Never overwrites: if something is already there, the restored copy is named `<name> (restored 16 Oct)`, then `(restored 16 Oct 2)`, …, and the name is checked with `private::sibling_clash` so it can't collide with a hidden private item. Needs Write on the original folder. Disabled with the reason if the original drive isn't connected.
  - A private item's backup restores into that private item, by its owner only. If the item itself is gone, it is recreated as a private item for the owner (`private::create`), never as a plain folder.

## 5. Cloud backups
### Format
- Files are split into content-defined chunks (FastCDC, about 1 MiB average). Small files are bundled.
- Chunk id = `HMAC-SHA256(dedup_key, chunk)`. Connect can't check for known files.
- **Dedup never crosses a key boundary.** Each shared backup has its own dedup key; each private-item owner has their own. A snapshot may only point at chunks in packs sealed with its own backup's key. Removing one backup can never break another.
- Chunks go into packs (about 32 MiB). Each pack has its own random key, encrypted with XChaCha20-Poly1305.
- A snapshot is an encrypted tree (names, sizes, times, chunk ids, grants) per protection per run.
- No per-file size cap (today's 2 GiB skip goes away); uploads resume pack by pack. Keep the idle trickle budget.
- Albums go into the export of a shared backup only after private items are filtered out. Favorites are not backed up (user decision, 2026-10-16).

### Keys
- **User key pair** (one per user): hybrid X25519 + ML-KEM-768, derived from that user's recovery phrase via HKDF with `info` = Luna id + purpose label. Luna stores only the public half.
- **Backup key** (one per shared backup): random. Luna holds it, and seals a copy on Connect to the public key of every user on that backup's saved access list (Admins are always on it, since they can read every non-private file).
  - A new access list on a successful run, or a grant change while the source is healthy: Luna re-seals the copies. Seconds, nothing re-uploaded.
  - **Someone removed from a list:** (precisely: the recipient set, everyone on the list with a phrase plus current Admins with a phrase, loses any key, for any reason: removal, demotion, deleted account, or a replaced phrase) the backup starts a new **key version** for every later pack and tree, sealed only to the current list; their sealed copies and share links are deleted. Copy says plainly what's true: what they could open before can't be taken back; everything backed up after their removal is closed to them, even if they kept an old key.
  - **Someone added to a list** gets only what's backed up from then on (user decision, 2026-10-16): adding a recipient also starts a new key version, and the newcomer is sealed only that version and later ones. Earlier versions and files deleted before they joined stay closed to them in the cloud.
  - A run seals each pack and its tree under the key version current at that moment; if the version changed mid-run, the commit seals under the new one.
  - The shared dedup key is stored wrapped under each key version and re-wrapped on every new version.
  - Every signed sealed copy covers: recipient public key, protection id, key version, Luna id.
  - Share-link scopes only reach backups the target user currently has a sealed copy of the latest key version for. So the share-link scope and "filtered by access list" are enforced by keys, not just the page.
  - **Nothing from Connect is trusted unsigned.** Sealing to a public key proves nothing about who sealed it, and Connect knows every public key. So:
    - Each phrase also derives a **self key** (HKDF, own purpose label): a symmetric key only that user's browser can use.
    - Luna keeps a random **signing key** (Ed25519). **No person ever holds its secret half.** Luna stores it in its system DB and a copy in every adopted drive's drive DB, **tagged with the Luna id**, so it survives losing the system DB (the drives are still there). A drive can carry copies for several Lunas; adopting a drive adds this Luna's copy and never overwrites one tagged for another Luna. A freshly set-up Luna looks for a copy matching its Luna id on every drive before ever making a new key. Someone with physical access to a drive could read it, which matches the rule already shipped: physical access to a drive reads everything on it.
    - At phrase setup, Luna's own signed-in web UI hands the browser the signing **public** key; the browser seals it with its self key (authenticated encryption) and uploads that. Connect can't forge or swap it.
    - Luna signs everything a browser or a recovering Luna must trust: the user public-key list, every sealed backup-key copy and key version, the Luna id, private trees and sealed private dedup keys.
    - Luna signs one canonical, domain-separated **snapshot record** per run: Luna id, protection id, snapshot id, time, key version, tree pack id, tree hash. Backup metadata (name, started by) is encrypted under the backup key and referenced from it, so Connect can't roll back, swap or regroup backups.
    - Pack id = SHA-256 of its ciphertext: Connect checks it on upload, browsers on download. After decrypting, browsers recompute each chunk's HMAC. Chunk ids never appear in plain on Connect (pack indexes are encrypted; there is no "have chunk?" call).
    - Browsers check every signature against the public key from their own self-sealed copy before decrypting, or before handing anything to Luna. Normally Luna uses its own records and never Connect's.
    - Admins joining or leaving never touches the signing key, so there is no rotation.
    - Only if the system DB **and** every drive copy are lost: Luna creates a new signing key. Each user adopts it by entering their phrase in Luna's own signed-in web UI (the same trusted route as first setup), which **adds** a second self-sealed public key and keeps the old one. Until a user does that, Connect shows them "Open Luna and enter your recovery phrase once to keep using your backups." Old signatures stay checkable through the old self-sealed public key, which is never replaced.
    - Belt and braces: after database-loss recovery, Luna starts new key versions (and a new private dedup key per owner) for all new data, so even a key it got back from Connect is never used to write.
- **Luna id:** random, minted by **Luna itself** at the first cloud setup (not Connect's device id, which changes with every new device token). Kept in the system DB, written into every drive manifest, and it tags every drive copy of the signing key. Luna registers it with Connect. It goes into every HKDF `info` and is never minted again, even after database loss, or every phrase would derive a different key. After database loss Luna accepts an id from Connect only if an attached drive holds a signing key tagged with it. Moving the id to a new device token needs a signature from the signing key.
- **Auth key:** each phrase also derives an Ed25519 **auth key** (own HKDF label); its public half is in the signed user list. Public keys are public, so every claim to hold a phrase (re-linking after database loss, rebuilding a private index, the phrase check, opening a private scope on Connect) signs a fresh challenge with it.
- Copies and private indexes are found through the signed recipient lists and records, and labelled with the user id they were sealed under, so they still open after user ids change. The phrase's keys, not the id, decide who can read them.
- **Private items:** packs and trees are sealed to the owner's public key. Only that owner's phrase opens them: not Luna, not an Admin, not us. Luna keeps a local plain index (trees, chunk ids, pack map) so incremental runs never unlock the cloud.
  - The owner's private dedup key is random, held by Luna, and a copy is sealed to the owner on Connect.
  - Rebuilding a private index (after database loss) happens **in the owner's browser**: they enter their phrase on a Luna page, the browser decrypts the trees and dedup key and hands Luna the plain index (names Luna already holds on its drives). The phrase never reaches Luna.
- **Recovery phrase:** 12 words from the BIP39 English list (128 bits, built-in checksum, unique 4-letter prefixes). Made **in the browser** (`crypto.getRandomValues`); Luna never receives the words. Keys derive from the 16 bytes of entropy (not the word string), fixed salt, `info` = label ‖ Luna id, labels `x25519` / `mlkem` / `self` / `auth`. One spec file with test vectors, read by both the Rust and JS tests. Sealing: ephemeral X25519 plus an ML-KEM-768 encapsulation, both shared secrets fed through HKDF, then XChaCha20-Poly1305 with associated data (RustCrypto in Luna; `@noble/curves`, `@noble/post-quantum` + `@noble/ciphers` in the browser). A copy opens only with both secrets, so it stays safe if either X25519 or ML-KEM is broken later. Both halves come from the same 128 bits of phrase entropy, so the phrase caps the strength of the whole scheme. Signatures (Ed25519) are not post-quantum yet.
- **Signing key** is made only once the Luna id exists and every drive has been scanned for a copy, and is written to every adopted drive before its first signature.

### Per-user setup (required before anything of theirs uploads)
1. The first time someone backs up to the cloud, or opens Settings → Cloud backup → "Get your recovery phrase".
2. The first phrase on a Luna must be an Admin's: a Member's first cloud backup waits with "Waiting for an Admin to set up cloud backup". This keeps every shared backup openable by an Admin.
3. One screen states it plainly: "Your recovery phrase opens your cloud backups. Write it down: if you lose it, your private items in the cloud can't be opened by anyone, including us."
4. Show the words. Offer **Print** and **Download**.
5. Confirm 3 random words while the phrase is still on screen. Public keys and the self-sealed blob upload only after that, and backup starts only after that. Luna never stores the words or anything per word.
6. Every few months: "Check your recovery phrase": type all 12 words; the browser derives the keys and signs a challenge from Luna with the auth key. Nothing secret leaves the browser.
7. Removing, demoting or deleting the last Admin who has a phrase, or replacing their phrase, is blocked until another Admin sets one up.

### Lost phrase
- "Get a new phrase" (needs the person signed in to Luna): new key pair; Luna re-seals every backup key they're on (seconds). The old phrase may be in someone else's hands, so this counts as losing a key: every backup they're on starts a new key version, and their private items get a new dedup key that never points at old-phrase packs.
- Their private items: Luna starts fresh private backups under the new key from the source files. The old private backup (sealed to the lost phrase) is treated as fully deleted the moment the fresh one starts: it's shown as "Sealed with your old phrase" and removed after 30 days, in case the phrase turns up. The owner can delete them sooner, after a prompt saying what's lost: earlier versions and deleted files that only existed in the old backup.

### Cleanup
- Luna knows from its index which chunks are unused. Shared packs: rebuild partly dead ones freely, since Luna holds the keys.
- Private packs: group chunks by file and run so packs age out whole. Rebuild only from source files that still exist unchanged.
- Packs belong to a **dedup scope** (one shared backup, or one private owner), not a single protection. Deleting a backup removes its snapshots, then runs cleanup in its scope.
- A pack's index row is written `pending(run id)` **before** it uploads, so a crashed upload is known and can be cleaned. A resumed run keeps its run id and start time across restarts. Marking and committing happen in one SQLite transaction; a commit unmarks any marked, not-yet-deleted pack it references.
- Mark first, delete later. A marked pack is never used for dedup (its chunks are uploaded again if needed). A marked pack is deleted only once at least 24 h have passed **and** every run **in that pack's dedup scope** that started before it was marked has ended; when a run commits, its snapshot's references are re-checked against marked packs. First backups can run for weeks, so no fixed delay is safe on its own.
- Cleanup never deletes a pack its index doesn't know (see "Luna loses its database").

### Checks
- Shared data: decrypt and verify a random sample each week.
- Private data: Luna downloads a random sample and hashes it itself against the hashes it recorded (never trusting Connect's answer). Whether the phrase still opens it is proven by the 12-word phrase check.

### Luna loses its database (while still running)
- Sealed backup keys, the signed user public-key list, the snapshot list and the Luna id live on Connect, so nothing needed is only in the system DB.
- Users live in `luna.db` (`config.rs:76`) and nothing backs that file up, so after the loss there are no accounts. Recovery:
  1. Luna is set up again (normal setup page, new Admin account) and re-binds to the same Connect account, which hands back the Luna id; Luna accepts it only if an attached drive holds a signing key tagged with it.
  2. The new Admin enters their old recovery phrase **in the browser**. Luna shows its recovered signing public key, and the browser compares it with its self-sealed copy before handing over anything. Any old phrase works; recovery rebuilds what that phrase opens and leaves the rest alone. Luna takes its signing key back from a drive copy tagged with the Luna id Connect handed back, and only that one. The browser opens its self-sealed copy of the signing public key, checks every signature (key list, sealed copies, Luna id), then hands Luna the unsealed shared backup keys. Luna rebuilds its shared index from the cloud.
  3. Drive protections are rebuilt from each drive's `manifest.json`.
  4. Old user ids in manifests and access lists match nobody: those backups follow the ownerless-items rule (Admin-only until an Admin gives them away). A person who sets up a new account and enters their old phrase is re-linked by public key, after signing a challenge with their auth key.
  5. Each private index is rebuilt when its owner does the same (in the browser, above). Until then those packs are left alone, never deleted as unknown.

### Space and first uploads
- A first backup of several TB on the idle trickle takes days or weeks, so it shows its own state: "First backup in progress · 1.2 of 3.4 TB", not "failing".
- Connect storage full: backups pause, the Backups card shows it with what to do (free space or a bigger plan), nothing old is deleted to make room.
- Admins see total cloud usage, private items included, as one total; never per person for private items. Admins can delete a deleted user's private backups to free space.

### What Connect sees
Account, device, pack ids and sizes, upload times, how many sealed copies of each backup key exist. Private packs carry an opaque scope id per owner per phrase, not the owner's public key. The Admin session API returns only the account total and a combined private status; listing or downloading a private scope needs an auth-key signature (signed in or by share link). Never names, folder layout, contents, or per-person private sizes.
- **Unbinding** (factory reset, removing the device token) starts the 30-day purge; binding again to the same account within 30 days reattaches the backups. Factory reset removes the drive markers and with them the drive copies of the signing key; its copy says cloud backups stay downloadable from Connect only.

## 6. Connect web UI (the only place to download cloud backups)
- **Sign in: Admin only** (the household Connect account). Members never sign in to Connect.
- **Enter a recovery phrase.** It opens exactly what that phrase's key pair has sealed copies for: the shared backups on that user's saved access lists, plus that user's private items. Keys stay in the browser; decryption happens there. The Admin's own phrase opens every shared backup.
- **Browse by user** (grouped by who started each backup), version picker, Download a file or a folder as a zip.
- Each user's group ends with one **Private items** row: no names, sizes or counts. Only that user's phrase opens it.
- **Share backup link** (for when someone else holds the phrase):
  - The Admin picks a scope, either one user's backups (private items included) or a single backup, and gets a link to send to the person who holds that user's phrase.
  - The link opens a page showing only that scope. The holder enters the phrase there, in their own browser, and downloads. The phrase never reaches the Admin or Connect.
  - Expires after 7 days; the Admin can revoke it any time; Connect lists active links and when each was last opened.
  - The link alone opens nothing: it reaches encrypted data, and the phrase is still required. The phrase opens only what its own key has copies for, within the link's scope.
  - Against phishing: the link page shows the Luna's name and who sent it, and phrase prompts everywhere say "Only type your recovery phrase on <Connect domain>." Honest limit: Connect serves the page that reads the phrase, so "not us" depends on that page doing what it says. The code is open and the page is built reproducibly.
- Removes: today's `backup_objects` / `backup_bindings` path model, `BackupBrowser.jsx`, `backupTree.js`. The 30-day purge after unbinding becomes part of the retention policy.

## 7. Private items, Admin side
- **Cloud:** Admins can't open private backups, by design. They see the Private items row and a combined status ("All backed up" / "1 problem") so they can fix the cause (full drive, subscription), while details go to the owner.
- **Deleted user:** their private backups stay listed ("Private items · deleted user"). An Admin can delete them but not open them. Drive copies follow the existing rules for a deleted owner's private items; cloud copies are unreadable without the phrase.

## 8. Status and reassurance (Luna)
- **Shield sheet:** each existing backup with its state ("Backed up 2 hours ago · Backup drive", "Waiting: drive not connected", "First backup in progress · 40%"), plus a line shown on **every** folder and drive, whether or not anything private is inside: "Private items inside aren't included. Their owners back them up separately."
- **On private items (owner only):** "Not backed up" with a shield, until one exists.
- **No Backups page.** A **Backups card on the dashboard**, for everyone (counts backups on your saved access lists plus your own private items):
  - Top of the card: `All backed up` / `1 backup needs a look` / `No backups yet`, plus `9 backups · copies last tested 2 days ago` (§5 Checks).
  - Below, only when there's something to do (at most 3, most urgent first): failing backups with the reason and a fix button; `Check your recovery phrase` when due. Only about existing backups, never nudges about unprotected items.
  - Empty: `No backups yet.` / `Click the shield icon beside an item to back it up.`
  - Backup problems show here only, not in the dashboard's "Needs a look" card; the system health pill still counts them.
- **See all backups** opens a ModalCard: grouped by user (same as Connect), rows with name, destination pill, status pill, last good copy; one **Private items** row per user with a combined status; filter chips `All` / `Needs a look` / `Cloud` / `Drives`. Clicking a row opens its shield sheet, or, if the source is gone, its Backups-folder entry or a link to Connect. No downloads here.
- **Health checks** read the same records (`backup/status.rs` rules stay).
- **Toasts** only for user actions (backup started or deleted). Failures live in status, not toasts.

## 9. Teardown
Luna:
- `backup/protect.rs`, `backup/cloud_backup.rs`, `put_private_manifest`, the `backup_manifest` table, the old `protections` table, `.luna-<uuid>-protected` (`Layout::protected_name`, `is_protected_store`).
- `api/protections.rs` routes.
- Web: `ProtectSheet.jsx`, `CloudBackupCategory.jsx`, `canProtect.js` / `useCanProtect.js` (rebuild them).
- Desktop/Android: **only** any Protect or cloud-backup screens that call these APIs (none found today). `desktop/src/backup.rs` and Android `PhotoBackupWorker.kt` copy *from* a computer or phone *to* Luna: they are not Protect and are not touched. In copy, the new feature is "Backups"; those keep their own names (for example "Photo upload from this phone") so the two never read alike.

Connect: the backup handlers, `backup_objects` / `backup_bindings`, the object store layout, `BackupBrowser.jsx`.

No migrations (early development).

## 10. Phases
1. Model + drive backups: protections table, engine, versions, manifest, Backups folder, shield sheet, status.
2. Cloud format + user key pairs + backup keys + recovery phrase setup (Luna side), uploads, retention, cleanup, checks, plus the minimal Connect storage endpoints (device-authenticated blob store with hash and quota checks), so phase 2 is tested against the real store, not only a fake.
3. Connect: new storage API, browser-side decryption, by-user browse, download, share backup links.
4. Private item backups: owner keys, local index, opaque rows.
5. Dashboard Backups card + See all backups modal, health checks, phrase-check reminders, desktop/Android.

## 11. Open for review
Decided: no gate on Members starting cloud backups; only the Admin signs in to Connect; Backups folder restores to the original folder too; drive and cloud keep the same versions; no Admin challenge for private items anywhere.

Nothing open.

## Decisions recorded 2026-10-17 (phase 2 review)
- A new key version (recipient set changed) gets a fresh dedup key, so the next run re-uploads everything. Deliberate: a kept dedup key would let newly added people open old versions. This supersedes "dedup key re-wrapped on every new version" above.
- Old key versions are never re-sealed (Luna can't open them without a phrase). Removing the original Admin can leave retained older copies unopenable by others; the last-Admin guard only covers new versions.
- Restore after DB loss needs the browser: a person enters their phrase, opens key copies, and sends keys to Luna so `rebuild_snapshot_index` can run. That flow (recover.rs wiring) belongs to phase 3.
- Identity: candidates come from drive key copies; Connect's luna-ids list only breaks ties. Requests carry X-Luna-Ts / X-Luna-Sig (domain "move") so a Luna can move to a new device.
