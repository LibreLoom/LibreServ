# Drive formatting and drive encryption: rebuild plan

Replaces the removed systems (see [`../drive-teardown/intents.md`](../drive-teardown/intents.md);
old code at `e29a2c2c`). Decisions below are the product owner's; defaults marked
*default* are ours and can be changed.

## The two rules this design exists to keep

1. **One format flow.** There is exactly one way Luna erases a drive: one backend
   operation and one frontend component, `FormatDriveFlow`. Every screen that
   needs a drive formatted opens that component. Nothing else erases.
2. **The person never chooses a filesystem.** Luna picks it:
   - no encryption → one exFAT partition (readable on Windows, Mac, Linux);
   - encryption → one LUKS2 container with ext4 inside.

Encryption is a **separate system** (state, unlock, lock, change password). When
it needs a drive erased it opens the format flow; it never formats on its own.

## Backend (lunad)

### Modules

Keep HTTP, SQL and disk work apart (the old `api/formatting.rs` mixed them).

| Module | Job |
| --- | --- |
| `drives/format/inspect.rs` | Read-only look at a physical disk: identity, partitions, contents, the **empty verdict** |
| `drives/format/run.rs` | The single erase: quiesce, wipe, partition, optional LUKS2, mkfs, marker, register |
| `drives/format/tools.rs` | `wipefs`, `sfdisk`, `mkfs.exfat`, `mkfs.ext4` behind a trait with a mock; every call has a deadline |
| `drives/crypt/luks.rs` | `cryptsetup` behind a `Luks` trait + mock (lift from `e29a2c2c`, drop `reencrypt_state`) |
| `drives/crypt/vault.rs` | Unlock, lock, change password (lift the unlock/lock steps from `e29a2c2c`) |
| `api/drive_format.rs` | Thin HTTP for preview/start/status |
| `api/drive_crypt.rs` | Thin HTTP for encryption state/unlock/lock/password |

**Only `run.rs` may call `wipefs`, `sfdisk`, `mkfs.*` or `cryptsetup luksFormat`.**
Adopt never erases; the encryption API has no "set up" endpoint.

### Format API (Admin only)

- `POST /api/v1/drive-format/preview { device }` → contents preview, `empty: bool`,
  `ready_at` (now if empty, now + 30 s otherwise), and a `preview_id`.
- `POST /api/v1/drive-format/start { preview_id, label, password? }` →
  `password` present means LUKS2 + ext4; absent means exFAT. Returns the format id.
- `GET  /api/v1/drive-format/{id}` → named phase, done/failed, error, resulting drive id.

The preview is held **in memory**, bound to the physical disk (serial/WWN, size,
full partition layout) and expires after 15 minutes. A lunad restart drops it; the
person previews again. No plan or operation tables. Status lives in memory too:
refreshing the browser finds the running format by id, or by disk via the drive
list (`formatting: true` on the device while it runs).

### The empty verdict and the 30-second wait

The server decides; the client never claims a drive is empty.

**Verified empty** (no wait) only when one of these is certain:
- no partition table and no filesystem or container signatures at all; or
- every partition mounts read-only and contains only entries the filesystem or
  an OS creates on its own: `lost+found`, `System Volume Information`, empty
  `$RECYCLE.BIN` / `.Trashes` / `.Trash-*`, `.fseventsd`, `.Spotlight-V100`,
  and Luna's own marker and cloud recovery files (the flow recreates them).

**Everything else waits 30 seconds**, counted on the server from when it issued
the preview: unreadable or unknown filesystems, locked LUKS containers, installer
media (iso9660) *(default)*, anything uncertain, any non-empty trash folder.

`start` re-checks: preview not expired, `ready_at` passed, same physical disk and
layout, and an empty verdict still holds (if files appeared, refuse and ask for a
new preview).

### The erase (`run.rs`)

One function, one path, for every caller:

1. Take the disk lock (the same lock adopt, eject and inspection use). Refuse if a
   format is already running on it.
2. Quiesce a registered drive: refuse open documents and running copies, hold
   backup run slots, flush the RAM cache, stop indexers, unmount, close any open
   LUKS mapping (lift `quiesce_for_format` from `e29a2c2c`).
3. Re-verify disk identity. Check every needed tool exists **before** writing;
   never fall back (no silent FAT32).
4. `wipefs`, one GPT partition across the disk, then either `mkfs.exfat`, or
   `luksFormat` (password on stdin, never argv) + open + `mkfs.ext4 -m 0`.
5. Mount the exact new partition/mapper, write and verify a fresh `.luna-*`
   marker, copy cloud recovery files, register in one transaction.

**The marker is the commit point.** A format interrupted at any step leaves no
valid marker, so after a restart the drive simply shows as needing setup and
leads back into the flow. Destructive work never resumes on its own.

On success an encrypted drive is left **unlocked** and ready.

*Default:* reformatting a registered drive keeps its id and name and whole-drive
member access; finer access (links, file/folder/album grants), recents and
affected backup rules are cleared (lift `invalidate_formatted_contents`).

### Encryption system (separate)

- `GET /drives/{id}/encryption`, `POST /drives/{id}/unlock`, `/lock`, `/password`,
  plus unlock-and-add for an encrypted drive Luna hasn't registered yet.
- LUKS2 profile as before: AES-XTS 512-bit, Argon2id with memory = 1/8 RAM clamped
  to 32 MiB..1 GiB (the 2 GiB Wyse OOM). One keyslot. **No recovery:** forget the
  password, lose the files, and the UI says so plainly before formatting.
- Password change: add new keyslot, verify, remove old (Admin, needs current one).
- Startup never mounts an encrypted drive; after a boot they're all locked.
  After a daemon-only restart, check mapper + mount + marker before deciding.
- One gate: `files::drive_root()` refuses a locked drive (HTTP 423), which covers
  browse, uploads, WebDAV, gallery, search and backups.
- Per-user, per-drive unlock rate limit (five tries).
- Backups refuse an encrypted source with a plain target, at creation and every run.
- **No `converting` column.** "Formatting" is the in-memory run, not DB state.
  `drives.encrypted` and `drives.locked` come back.

### exFAT is now the default: audit before shipping

Luna already adopts exFAT drives, but check (don't assume) that files code handles:
reserved name characters (`: * ? " < > | \`) in uploads, renames and WebDAV;
case-insensitive name collisions; no Unix permissions (the read-only-drive
behaviour); no symlinks or xattrs; no journal (run `fsck.exfat` on mount after an
unclean unplug). Fix gaps in the files layer, not in the format flow.

## Frontend (`luna/web`)

### `FormatDriveFlow` (one component)

`<FormatDriveFlow device={…} password={optional} onDone={…} onCancel={…} />`

Steps: **Preview** (what's on the drive; "Luna can't read this drive" when it
can't) → **Confirm** (the erase button, disabled with a visible countdown until
`ready_at` when the drive isn't verified empty) → **Formatting** (named phases) →
**Done** (opens the drive) or **Failed** (what happened, whether anything was
erased, what to try).

It shows no filesystem and no encryption toggle. Whether to encrypt comes in from
the caller as `password`. Closing it mid-run is safe; reopening finds the run.

### Who opens it

| Entry point | Opens the flow with |
| --- | --- |
| Add drive: blank, damaged, foreign-format or installer stick | no password; a "Protect with a password" link hands off to the encryption sheet first *(default)* so nobody erases twice |
| Drive card → Erase drive | no password (or the drive's current protection choice, asked in one line) |
| Encryption sheet → Protect this drive | the password (collected twice, with the no-recovery warning) |
| Encryption sheet → Remove protection | no password; the sheet says this erases the drive |
| Encrypted drive Luna can't open (forgotten password, foreign LUKS) | no password; "Erase and start over" |

### Encryption UI (separate)

`DriveEncryptionSheet`: state, Protect / Remove protection (both hand off to the
flow), Change password, Lock. Unlock is a small prompt on the drive card and in
the Add-drive window. "Locked" pill in `DriveStatusPill`.

Both components follow the AGENTS.md rules (plain words, tokens, haptics from the
primitives, toasts only for finished results, render tests for each).

## Lift vs rewrite from `e29a2c2c`

- **Lift after review:** `luks.rs` (trait + mock), unlock/lock in `vault.rs`,
  `quiesce_for_format`, `invalidate_formatted_contents`, the marker write/verify in
  `register_formatted`, mount deadlines, Argon2 memory sizing, the backup pairing rule,
  the unlock rate limiter.
- **Rewrite:** the format API, plan/review/operation storage (gone), `FormatDriveSheet`
  (becomes `FormatDriveFlow`), the empty verdict (new), `api/formatting.rs`.

## Order of work

1. Backend format: `inspect` + empty verdict, `tools` with mocks, `run`, API. Mock
   (directory) drives simulate the run and refuse encryption.
2. `FormatDriveFlow` + Add-drive and Erase entry points; fake lunad and contract cases.
3. Encryption system backend + `drive_root` gate + backup rule.
4. Encryption sheet, unlock prompt, Protect/Remove hand-offs.
5. exFAT audit fixes in the files layer.
6. Trim `os/` packages to what's used (`exfatprogs`, `e2fsprogs`, `cryptsetup`,
   `util-linux` for `sfdisk`/`wipefs`).

## Verification

- Every step: `./ci check -r`; fake-lunad scenarios for each entry point, for
  wait and no-wait, failure, and a refresh mid-format.
- **Real hardware (needs the owner's go-ahead):** pull power mid-format, unplug
  mid-format, wrong-password unlock and rate limit, password change, Argon2 unlock
  on the 2 GiB Wyse, exFAT and LUKS drives read on another computer.
