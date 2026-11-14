# Drive encryption and formatting: what they were for

Luna's drive encryption and drive formatting systems were removed so they can be
redesigned from scratch. This file records what they were for, so the redesign
does not start blind.

- **Last commit with the full code: `e29a2c2c55be99a6a0f726112c3fc8a4ed62228c`.**
  Find anything below with `git show e29a2c2c:<path>`.
- The old design write-up is in [`../drive-encryption/plan.md`](../drive-encryption/plan.md).
  It is marked superseded by [`../drive-format/plan.md`](../drive-format/plan.md), the
  rebuild plan; read the rebuild plan first.
- Origin commits: `02b86f46` (2026-11-02, LUKS2 + in-place conversion), `722e5f96`
  (one format backend, encryption by wiping), `0144fd5f` (deadlines on every disk
  tool), `3babf20c` (2026-11-08, separate encryption from formatting; durable
  reviewed plans), `b94ad4b1` (fixes after that refactor). The whole thing is
  about ten days old, nothing was verified on real hardware.

## Why it existed (product intent)

1. **Prepare a new drive without a terminal.** A person plugs in a blank, damaged
   or Windows-only stick and Luna has to make it usable from the browser. That
   meant partitioning and writing a filesystem, safely, with a clear warning of
   what gets erased.
2. **Protect files if a drive is lost or stolen.** An encrypted drive is useless
   without its password when plugged into another computer. The key lives only in
   RAM, so power loss locks the drive again.
3. **Erase installer media.** Installer USB sticks mount read-only; the old flow
   offered "Erase and add this drive".

## Pieces

### Encryption (LUKS2)

| Piece | What it did |
| --- | --- |
| `drives/luks.rs` | `cryptsetup` wrapper behind a `Luks` trait (`format`, `open`, `close`, `change_password`, `is_open`, `reencrypt_state`) plus a `MockLuks`. |
| `drives/vault.rs` | Unlock (open, mount ext4, verify the `.luna-*` marker id matches), lock (unmount first, then close), `inspect_identity` (temporary read-only mount of an encrypted drive to learn its id), and `record_unlocked` / `record_locked` DB updates. |
| `api/encryption.rs` | `GET /drives/{id}/encryption` (state), `POST /drives/{id}/unlock`, `/lock`, `/password`, `POST /drives/{name}/unlock-and-add` (add a locked, never-registered encrypted drive after proving the password and identity). Per-user per-drive unlock rate limiter (`AppState.unlock_limiter`, five tries). |
| Web | `DriveEncryptionSheet`, `lib/encryption.js`, "Locked" pill in `DriveStatusPill`, unlock form in `InspectModal`, drive-card "Encryption" / "Unlock" button. |
| DB | `drives.encrypted`, `drives.locked`, `drives.converting`. |

**On-disk and key design**

- One partition, one LUKS2 container, ext4 inside, one keyslot, one password.
- Profile, "frozen": `aes-xts-plain64`, 512-bit key, 512-byte sectors, Argon2id.
  Argon2id memory = one eighth of available RAM, clamped to 32 MiB..1 GiB, chosen
  at format time (LUKS2's 1 GiB default OOM-killed a 2 GiB Wyse) and recorded in
  the header.
- Mapper name `luna-vault-<drive id>` under `/dev/mapper`; the unlocked mount is
  the normal `data_dir/mounts/drives/<id>`, so nothing downstream knew a drive
  was encrypted.
- The password only travels on stdin (`--key-file -`) or a memory-only fd, is
  zeroized on drop, and is never stored. The volume key lives only in the kernel
  dm-crypt mapping. The daemon disables core dumps for this reason.
- Unlock flow: resolve the real container partition (`DriveManager::luks_partition`,
  refuses zero or several containers) -> `luksOpen` -> mount -> check marker id ->
  publish `locked = 0`. Any failure closes what that attempt opened. Lock flow:
  refuse active jobs/documents, flush pending saves, unmount, `luksClose`.
- Password change: add new keyslot, verify, remove old one (Admin only, needs the
  current password). No reformat.
- Startup reconcile never mounts an encrypted drive; after a boot everything
  encrypted is `locked`. After a daemon-only restart a mapper may still be open,
  so startup (`format_lifecycle::startup`) checks mapper + mount + marker before
  deciding.
- One gate: `files::drive_root()` refused a locked or converting drive (HTTP 423,
  code `drive_locked`) so browse, uploads, WebDAV, gallery, search and backups
  all stopped in one place. WebDAV (`files/dav.rs`, `dav_fs.rs`) mirrored it.
- `drive_backup.rs` refused to back an encrypted source onto a plain target (and
  re-checked every run), so a backup could not leak plaintext. The rule belongs
  with whatever encryption design returns.

**Relation to the recovery phrase: none.** The drive password was independent of
the cloud recovery phrase and had no recovery path ("forget it and the files are
gone", said in the format sheet). Only the format flow touched cloud material: it
copied the cloud identity recovery files onto the new filesystem
(`backup::cloud::identity::copy_to_drive_at`). That function is cloud-backup code
and stays.

### Formatting

| Piece | What it did |
| --- | --- |
| `drives/format.rs` | One backend, `run()`: unmount everything on the disk (refuse if busy), `wipefs`, one partition across the disk (`sfdisk`), optional LUKS container, then `mkfs`. `Target` = filesystem (exFAT or ext4) + label + encrypt. `FormatError` (Busy, Unresponsive, MissingTool). `Mkfs` trait + mock so tests never hit a device. |
| `drives/ext4.rs` | `mkfs.ext4 -m 0` and `free_bytes` (statvfs). |
| `drives/wipe.rs` | Read-only "what would be lost" measurement (`used_bytes`, `Contents`) for the review step and for `Inspection.used_bytes`. Its original job was the 16 MiB "meaningful content" threshold; the threshold was dropped in 3babf20c (every format gets the 30 s review) and only the measuring is left. |
| `drives/format_lifecycle.rs` | `quiesce_for_format` (refuse open documents / running copies, hold backup run slots, flush RAM cache, unwatch indexers, unmount), `finish_format`, `invalidate_formatted_contents` (new content generation: revoke links and path grants, stop backup rules, clear recents), `register_formatted` (mount the exact new partition, write and verify a fresh marker, copy cloud identity, register in one transaction), and `startup` (mark unfinished operations `interrupted`). |
| `api/formatting.rs` | `/api/v1/drive-format/{capabilities, plans, plans/{id}/review, plans/{id}/start, operations, operations/{id}}`. Admin-only. |
| Web | `FormatDriveSheet` (Choose, Review, Format, Result), `lib/formatNotifications.js`, "Format details" / "Format" buttons on drive cards, format hand-off from `InspectModal`. |
| DB | tables `drive_format_plans`, `drive_format_operations`; `drives.converting` (reused as the "a format is running or must be reviewed" gate). |
| Health | the `erase_tools` system check (wipefs, sfdisk, mkfs.exfat present) in `system/system_health.rs`. |

**Format lifecycle**

- Plan: immutable, Admin-owned, expires after 15 min, bound to the observed
  physical attachment and full partition geometry (fingerprint). Preview lists
  every partition and its top-level entries; "unreadable" is shown honestly.
  Passwords never enter the stored plan.
- Review: server-enforced 30 s wait starting when the client posts `/review`
  after rendering the preview (client-triggered; see flaws).
- Start: consumes the plan once, returns a durable operation. States:
  `queued -> running -> succeeded | failed | interrupted`; `phase` is a named
  step; `destructive_started` records whether anything was written. A destructive
  failure keeps the drive gated until reviewed again; restart marks unfinished
  operations `interrupted` and never repeats destructive work.
- Scope: whole physical drive replaced by one partition (`scope: "drive"` is in
  the API so a partition scope can be added later). exFAT (plain) or ext4 (plain
  or LUKS2). Never silently FAT32.
- Mock (directory) drives were simulated: they skipped disk tools and refused
  encryption.
- Reformatting keeps the drive id (new marker written) so the drive keeps its
  name and whole-drive member access; everything finer was revoked.

## What depended on them (and what was changed when removed)

- `drives/mod.rs`: `DriveManager` carried `luks` and `mkfs`; `Inspection` / `Peek`
  carried `locked`, `needs_erase`, `used_bytes`; reconcile treated encrypted
  drives specially (never mounted, `lock_ids`).
- `api/drives.rs`: drive JSON carried `encrypted`, `locked`, `converting`; adopt
  accepted `erase`, `encrypted`, `password` (already refused with
  `format_review_required`); eject/remove refused while formatting.
- `files/mod.rs`, `files/dav.rs`, `files/dav_fs.rs`, `api/files.rs`: locked and
  `drive_converting` gates.
- `backup/drive_backup.rs`: the encrypted-source/plain-target pairing rule
  (the only edit made inside the "off-limits" backup area, because it read the
  removed `encrypted` column).
- `system/system_health.rs`, `api/health.rs`: the `erase_tools` check.
- Web: `FilesPage`, `FilePage`, `InspectModal`, `DriveStatusPill`, `lib/drives.js`,
  fake lunad (`dev/fake/world.js`, `handlers/core.js`), contract `cases.js`,
  scenarios `files/encryption*`.

## Known flaws and open problems (carry into the redesign)

- Nothing was verified on real devices: no power-cut test, no real cryptsetup
  keyslot test, no hot-unplug during format. Static checks only.
- `converting` was named for the removed in-place conversion but became the
  format gate; one flag meant two things.
- `reencrypt_state` was residue from in-place conversion removed in 722e5f96;
  it parsed cryptsetup 2.7 output wrongly even then.
- The 30 s review wait started when the browser posted `/review`; a script could
  skip the rendering guarantee. The deadline lived on the plan, not on proof the
  person saw the preview.
- Format code was written in one large generated commit (3babf20c, "Implemented
  by Codex; committed as-is"); `api/formatting.rs` mixed HTTP, SQL, planning and
  execution in dense one-line queries.
- Single keyslot, no recovery: forgetting the password loses the data; the cloud
  recovery phrase does not help. A redesign must decide whether to link them.
- Encrypted drives could only use ext4; there was no cross-platform reader.
- No idle auto-lock; no way to migrate a plain drive to encrypted without erasing.
- The mock/dev drives could not exercise encryption or real formatting.
- Backup interplay was partial: pairing rule existed, but there was no check for
  a backup *target* being formatted behind a running rule beyond stopping rules.

## Unclear boundaries

- `wipe.rs` mostly served formatting, but `used_bytes` also fed
  `Inspection.used_bytes` for the Add-drive card ("does this hold anything?").
- `fsprobe.rs` is shared: partition probing, `pick_mount_source`, `needs_erase`
  for blank/installer media, and `sanitize_volume_label` (format only). Kept for
  detection and mounting; format-only and encryption-only parts were cut.
- `needs_erase` (blank, damaged or foreign-format sticks, installer media) is a
  formatting concept but also drove the Add-drive card wording. It is gone; those
  drives are now reported as not usable yet.
- `luna_core` marker/`drive_db` code is shared with plain adoption and stays.
- `os/` still installs `cryptsetup`, e2fsprogs, exfat tools, `sfdisk`, `wipefs`
  (image build files, `flash-disk.sh`). Left alone; trim when the redesign decides
  what it needs. `scripts/mocks/mock-drive.py` is a mock USB cluster, left alone.

## UI gaps after removal (plain messages in the product)

These are the places a person used to be led into formatting or encryption.
They now say so instead of dead-ending.

- **Blank, damaged, foreign-format or installer-media sticks** (Files -> detected
  drives; Add-drive window): previously "Erase and add" / "Format drive". Now the
  card says "Setting up new drives isn't available in this version yet." and
  offers no action.
- **Read-only sticks that were to be reformatted**: same message.
- **Encrypted drives** (already formatted with LUKS2): Luna can't open them.
  They show as "Encrypted" with "Luna can't open encrypted drives in this version
  yet." No unlock, lock or password change.
- **Drive card buttons "Format", "Format details", "Encryption", "Unlock"** and the
  `/files/:id/encryption` entry point: removed.
- **Setup wizard** has no drive step. Its "Now plug in a USB drive" line is still
  true, so it was not changed.

Drives that are already set up (have a `.luna-*` marker, plain filesystem) keep
working: listing, adding, mounting, health, eject, remove.

Where the messages live: `drives/mod.rs` (`NEEDS_SETUP_MESSAGE`,
`ENCRYPTED_MESSAGE`), `api/drives.rs` (`plain_adopt_error`), `InspectModal.jsx`,
`FilesPage.jsx` (`describePeek`). The Add drive button is disabled for drives
that report `needs_setup` or `encrypted`. The API fields `needs_erase` and
`locked` became `needs_setup` and `encrypted` on peek/inspect; the drive list
lost `encrypted`, `locked` and `converting`; adopt only takes `label`.

## Left in place on purpose

- `os/` still installs cryptsetup, exFAT/ext4 tools, `sfdisk`, `wipefs`;
  `os/lib/flash-disk.sh` writes the OS image and is unrelated.
- `drives/mount.rs` keeps the mount/umount deadlines and the `DriveUnresponsive`
  error (and `is_unresponsive`, now only used by its own tests); they harden
  plain mounting too.
- The daemon still disables core dumps (`sandbox::disable_daemon_core_dumps`);
  the cloud recovery phrase passes through it as well.
- `backup/cloud/identity::copy_to_drive_at` still runs when a drive is added.
- `docs/drive-encryption/plan.md` describes the removed code; its banner points to
  the rebuild plan.
- `web/src/dev/contract/lunad-responses.json` is stale (still has the removed
  routes and drive fields) until the next full luna run regenerates it.
- Existing dev databases may still carry the old `drives.encrypted/locked/converting`
  columns and the two `drive_format_*` tables; nothing reads or writes them
  (no migration, per the early-development rule).
