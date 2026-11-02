# Encrypted drives — plan for review (2026-11-02)

Planning only. Nothing here is built yet. **LUKS2 + ext4, Luna side only.** The computer-side reader is deferred (§7).

## 1. Scope

Building now:

- **R1.** Off by default; one option turns encryption on for one drive.
- **R4.** The key lives only in RAM on the Luna.
- **R5.** Someone unlocks the drive after Luna boots.
- **R6.** Web UI access to a locked drive opens an unlock dialog.
- **R7.** API/WebDAV access fails with a code saying "unlock it in the web page".

Deferred: reading the drive on a non-Luna computer. Until the reader exists, an encrypted drive is readable only by a Luna. That is a real product limit, not a detail — an encrypted drive is not a portable archive yet.

## 2. Why this is small now

Once unlocked, the mount is an ordinary ext4 filesystem, so **Luna's file layer does not change at all**. Marker, microdb, trash, thumbnails, private items, jobs, drive backups, WebDAV, the path jail — all keep working. No FUSE server, no new file abstraction, no SQLite-on-FUSE problem. The drive microdb moves inside the container for free, so a locked drive reveals nothing, not even file names.

The work is: detect it, unlock it, gate access while locked, and format new ones.

## 3. Layout

```
/dev/sdb1                              LUKS2 (aes-xts-plain64, 512-bit key, argon2id)
  └─ /dev/mapper/luna-vault-<drive-id> opened only while unlocked
       └─ ext4                         mounted at mounts/drives/<drive-id>
            ├─ .luna-<uuid>.sqlite3    marker + microdb, now encrypted
            └─ photos/ …
```

One partition, one container, ext4 inside. The partition label carries the drive name, so a locked drive still shows *"Photos"* — labels read without unlocking, and the name is not a secret.

**Fix the LUKS2 profile now** even though nothing reads it yet: single cipher `aes-xts-plain64`, 512-bit key, `argon2id`, no `dm-integrity`, 512-byte sectors. Once drives exist in the wild, changing this breaks every future reader.

## 4. Keys

LUKS2 has eight independent keyslots, which maps onto the requirements directly:

| Keyslot | Opened by | Purpose |
|---|---|---|
| 0 | the drive password | normal unlock |
| 1 | a 24-word BIP39 recovery phrase | forgotten password |

No custom key-wrapping code — `cryptsetup luksAddKey` does the second slot, and the phrase reuses the cloud backup wordlist (`phrase_to_entropy` / `entropy_to_phrase`).

- **The passphrase is never an argument.** `cryptsetup luksOpen --key-file -` reads stdin; anything on the command line is world-readable in `/proc/<pid>/cmdline`.
- **After unlock, no key is kept in userspace at all.** The volume key lives in the kernel's dm-crypt, which is not swappable and is wiped by `luksClose` or power loss. R4 holds more cleanly than holding a key in a process.
- **Argon2id memory must be lowered.** LUKS2 defaults to 1 GiB, which OOM-kills on a 2 GiB Wyse ([docs](https://man7.org/linux/man-pages/man8/cryptsetup-luksFormat.8.html), [writeup](https://sleeplessbeastie.eu/2021/07/05/how-to-open-luks2-encrypted-volume-on-a-low-memory-device/)). `budget.rs` already caps single allocations at an eighth of free RAM — pick the cost from `budget::meminfo()` at format time and record it in the header.
- **`RLIMIT_CORE = 0` at startup.** dm-crypt keys aren't in the daemon's address space, but the passphrase passes through it. `sandbox.rs` sets no-core-dumps for children; the daemon itself does not.

## 5. Luna side

### Detection — the part that needs care

`blkid` reports a LUKS partition as `crypto_LUKS`, which is **not** in `is_writable_type`. So today `pick_mount_source` skips it and `peek` falls through to mounting it read-only, which fails — the UI would say *"Can't open"* for a perfectly good drive.

Add `is_luks_type()` and handle it explicitly in `choice_for`, `peek` and `inspect`:

- a `crypto_LUKS` partition is a candidate, never `needs_erase`
- `peek` does not mount it; it reads the label and reports locked
- the Add-drive card says *"This is an encrypted Luna drive. Add it, then enter its password."*
- a drive with no marker and no LUKS is unchanged

### Unlock, lock, mount

| When | What happens |
|---|---|
| Boot | `reconcile` sees the LUKS partition, records the drive as locked, does not open it |
| Unlock | `luksOpen` → `mount -t ext4` → existing adopt/reconcile continues normally |
| Lock | flush, `umount`, `luksClose`, mark locked |
| Eject / remove | lock first, then release the device |
| Power off | nothing to do — the key was only ever in the kernel |

`mount_point` keeps its meaning. The only new state is a `locked` column.

**Do not add a `locked` drive state.** `state` is a string compared against `"as_is"` in ~15 places, and a locked drive is still present and healthy. Instead:

- `files::drive_root()` — the one function every file operation already goes through — filters `locked` and returns `FilesError::Locked`
- `map_files_err` turns that into **HTTP 423**, `code: "drive_locked"`, *"This drive is locked. An Admin can unlock it in Luna's web page."*
- `dav_handler_for` gets the same check, so Finder/Explorer show a real error rather than an empty folder
- the drive card shows a `Locked` pill before it considers `isUnopenable`

### The unlock dialog (R6)

One global handler, not a check on every page: a `drive_locked` response anywhere opens the dialog for that drive. On success, invalidate the failed queries rather than replaying them. Copy: title `Unlock Photos`, field `Password`, under it *"This drive stays unlocked until you lock it or Luna restarts."*, wrong password shakes with *"That password didn't work."*, five wrong gets *"Too many wrong tries. Wait a few minutes, then try again."*

**Admin only, v1**, on the same rate-limiter pattern as `login_limiter`. A Member with a live session could otherwise sit and guess.

**No idle auto-lock in v1** — gallery indexing, cloud backup and search indexing run against the mount, and an idle timer would kill them mid-run.

### Image and new drives

- `cryptsetup` is **not in the image today** (no package, and `dm_crypt` is not in the module set). Add the package, `dm-mod` and `dm-crypt` to `modules-load.d`, and extend the existing "every helper program lunad needs is present" check in `00.frag`.
- `format_data_usb` currently writes one FAT/exFAT partition. For an encrypted drive: `sfdisk` (already used), `cryptsetup luksFormat`, `mkfs.ext4` inside it (e2fsprogs is already there), then adopt as normal.

## 6. What still leaks

- **The central database.** `luna.db` is on the Luna's own disk, which this does not encrypt, and it records paths in the clear: `user_recents.path`, `path_moves`, `access_members`/`access_links.path`, `protections.source_path`, `jobs.from_path`/`to_path`. So the honest claim is **"a stolen Luna shows what files you have, not what is in them."** Accepting and saying that is cheap. Encrypting those columns touches grants and protections and makes them unreadable while locked. **Recommendation: accept for v1.**
- **Drive backups.** `backup/drive_store.rs` writes plaintext copies onto the target drive — backing up an encrypted drive to an unencrypted one silently undoes the feature. Refuse that pairing, or require the target to be encrypted too.
- **The drive label** is readable while locked. Deliberate, and worth stating in the setup dialog.

## 7. Deferred: the reader

Not built now. When it is, it is the critical path — LUKS2 header, Argon2id, the AF merge, AES-XTS, then read-only ext4 ([ext4-view](https://docs.rs/ext4-view)). There is no mature cross-platform LUKS2 crate, so it is ours to write, and it must be verified against real `cryptsetup` volumes in CI rather than against itself.

Two consequences of deferring it that are worth knowing now:

- **A drive with no Luna is unreadable.** That is the whole point of the feature for a user who wants their files on a laptop, and it does not exist until the reader ships. Say so in the UI when encryption is turned on.
- **The format profile is frozen at phase 0.** Get it right before drives exist.

## 8. Phases

| Phase | Work |
|---|---|
| **0** | Fix the LUKS2 profile. Decide the recovery phrase and who may unlock (§9). |
| **1** | Image: `cryptsetup`, `dm-crypt`, presence check. Luna: detection, unlock/lock, `locked` column, 423 on API and WebDAV, unlock dialog. |
| **2** | New-drive format path: partition → `luksFormat` → `mkfs.ext4`. Recovery-phrase keyslot. |
| **3** | Parity: drive-backup pairing rules, the §6 leak audit. |

Conversion of an existing drive is `cryptsetup reencrypt`, which works in place but is hours on a full drive and needs the last 32 MiB free. **Leave it out of v1** — encryption on new drives only.

## 9. Decisions I need from you

1. **Recovery phrase: yes or no?** A second keyslot, so cheap to add. Without one, a forgotten password destroys the files.
2. **Who may unlock?** Admin only (my recommendation), or anyone with access to the drive?
3. **Existing drives, or new ones only?** I recommend new ones only for v1.
