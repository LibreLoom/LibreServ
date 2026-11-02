# Encrypted drives — plan for review (2026-11-02)

Planning only. Nothing here is built yet. **Revised for LUKS2 + ext4**, reader shipped from the docs site.

## 1. Requirements

- **R1.** Off by default; one option turns encryption on for one drive.
- **R3.** A reader app takes a password and shows the files on a non-Luna computer.
- **R4.** The key lives only in RAM on the Luna.
- **R5.** Someone unlocks the drive after Luna boots.
- **R6.** Web UI access to a locked drive opens an unlock dialog.
- **R7.** API/WebDAV access fails with a code saying "unlock it in the web page".

R2 (`/blocks` on the drive) is **dropped** — a LUKS2 volume is one encrypted device with no filesystem outside it, so there is nowhere to put files. The reader comes from a downloads page instead.

## 2. What this buys, and what it costs

**Buys:** Luna's entire file layer is unchanged. Marker, microdb, trash, thumbnails, private items, jobs, drive backups, WebDAV, the path jail — all keep working, because once unlocked the mount is an ordinary ext4 filesystem. No FUSE server, no new file abstraction, no SQLite-on-FUSE problem. The drive microdb moves inside the container for free, so a stolen drive reveals nothing at all — not even file names.

**Costs:** the drive is unreadable without our reader app, on every OS, forever. And the reader is now the dominant piece of work, not Luna.

## 3. Layout

```
/dev/sdb1                 LUKS2 container (aes-xts-plain64, 512-bit key, argon2id)
  └─ /dev/mapper/luna-vault-<drive-id>    opened only while unlocked
       └─ ext4                            mounted at mounts/drives/<drive-id>
            ├─ .luna-<uuid>.sqlite3       marker + microdb, now encrypted
            ├─ photos/ …
            └─ .luna-<uuid>-trash/ …
```

One partition, one container, ext4 inside. The partition label carries the drive name (`cryptsetup config --label`), so a locked drive still shows *"Photos"* in the UI — labels are readable without unlocking, and the name is not a secret.

**LUKS2 parameters are fixed and minimal**, so the reader has one shape to parse: single cipher `aes-xts-plain64`, 512-bit key, `argon2id`, no `dm-integrity`, sector size 512. Anything else is a format the reader refuses rather than guesses.

## 4. Keys

LUKS2 has **eight keyslots**, each independent, each with its own KDF parameters. That maps onto the requirements directly:

| Keyslot | Opened by | Purpose |
|---|---|---|
| 0 | the drive password | normal unlock |
| 1 | a 24-word BIP39 recovery phrase | forgotten password |

- No custom key-wrapping code: `cryptsetup luksAddKey` and `luksChangeKey` do it, and the recovery phrase is just a second passphrase. The phrase uses the same wordlist and entropy handling as cloud backup (`phrase_to_entropy` / `entropy_to_phrase`).
- **The passphrase is never an argument.** `cryptsetup luksOpen --key-file -` reads it from stdin; anything on the command line is world-readable in `/proc/<pid>/cmdline`.
- **After unlock, no passphrase is kept at all.** The volume key lives in the kernel's dm-crypt, which is not swappable and is wiped by `luksClose` or power loss. That satisfies R4 more cleanly than holding a key in userspace.
- **Argon2id memory must be lowered.** LUKS2 defaults to 1 GiB, which OOM-kills on a 2 GiB Wyse ([cryptsetup docs](https://man7.org/linux/man-pages/man8/cryptsetup-luksFormat.8.html), [low-memory writeup](https://sleeplessbeastie.eu/2021/07/05/how-to-open-luks2-encrypted-volume-on-a-low-memory-device/)). `budget.rs` already caps single allocations at an eighth of free RAM. Pick the memory cost once at format time from `budget::meminfo()`, record it in the header, and every reader honours whatever is recorded.
- **`RLIMIT_CORE = 0` at startup.** dm-crypt keys aren't in the daemon's address space, but the passphrase passes through it. `sandbox.rs` sets no-core-dumps for children; the daemon itself does not.

## 5. Luna side

### Detection — the part that needs care

`blkid` reports a LUKS partition as `crypto_LUKS`, which is **not** in `is_writable_type`. So today `pick_mount_source` skips it, and `peek` falls through to mounting it read-only, which fails — the UI would say *"Can't open"* for a perfectly good drive.

Add `is_luks_type()` and handle it explicitly in `choice_for`, `peek` and `inspect`:

- a `crypto_LUKS` partition is a candidate, never `needs_erase`
- `peek` does not mount it; it reads the label and reports `locked: true`
- the Add-drive card says *"This is an encrypted Luna drive. Add it, then enter its password."*
- a drive with no marker and no LUKS is unchanged

### Unlock, lock, mount

| When | What happens |
|---|---|
| Boot | `reconcile` sees the LUKS partition, records the drive as `locked`, does not open it |
| Unlock | `luksOpen` → `mount -t ext4` at `mounts/drives/<id>` → existing adopt/reconcile continues normally |
| Lock | flush, `umount`, `luksClose`, mark `locked` |
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

### Image

`cryptsetup` is **not in the image today** (no package, and `dm_crypt` is not in the module set). Add the package, `dm-mod` and `dm-crypt` to `modules-load.d`, and extend the existing "every helper program lunad needs is present" check in `00.frag` to include `cryptsetup`.

### New drives

`format_data_usb` currently writes one FAT/exFAT partition. For an encrypted drive: `sfdisk` (already used), `cryptsetup luksFormat` on the partition, `mkfs.ext4` inside it (e2fsprogs is already in the image), then adopt as normal.

## 6. The reader — the real work

A small static binary (`crates/luna-access`) that takes a drive path, asks for the password, serves a tiny embedded web UI on `127.0.0.1` and opens the browser. Read-only in v1.

What it has to implement:

1. **LUKS2 header** — 16 KiB header, JSON metadata area, binary keyslot area. Parse the JSON, find a keyslot, read its KDF parameters.
2. **Argon2id** to derive the keyslot key.
3. **AF merge** — LUKS2 stores keyslot material anti-forensically split across stripes and must be merged back. This is the fiddly part; it is documented but easy to get subtly wrong.
4. **AES-XTS** decryption with the sector tweak.
5. **ext4 read-only** — there is a real crate for this ([ext4-view](https://docs.rs/ext4-view)).

Steps 1–4 are ours; there is no mature cross-platform LUKS2 crate to lean on. Budget **3–5k lines plus tests**, and treat it as the project's critical path rather than an afterthought.

**It must be verified against real volumes, not against itself.** A round-trip test with our own code proves nothing. CI should create a volume with real `cryptsetup`, write a known tree, and require the reader to reproduce it byte for byte — including a wrong-password case and a corrupted-header case. If the reader has a bug, the drive is unreadable, and there is no second implementation to fall back on.

**Distribution.** Build from `desktop/packaging/{windows,appimage,macos}`, which already cross-builds all three from Linux, sign with the existing minisign key (`keys/luna.minisign.pub`), and publish on the docs site. The app refuses a LUKS2 header it does not understand — *"This drive was made by a newer Luna. Get the latest access app from …"* — rather than guessing.

**The gap the downloads page leaves:** a drive and no internet is a dead drive. One cheap mitigation, if you want it: a small second FAT32 partition on the drive holding the reader binaries. They are public binaries, so nothing is lost, and it recovers the `/blocks` convenience without touching the encryption. Worth deciding now because it changes the partition layout.

## 7. What still leaks

- **The central database.** `luna.db` is on the Luna's own disk, which this does not encrypt, and it records paths in the clear: `user_recents.path`, `path_moves`, `access_members`/`access_links.path`, `protections.source_path`, `jobs.from_path`/`to_path`. So the honest claim is **"a stolen Luna shows what files you have, not what is in them."** Accepting and saying that is cheap; encrypting those columns touches grants and protections and makes them unreadable while locked. **Recommendation: accept for v1.**
- **Drive backups.** `backup/drive_store.rs` writes plaintext copies onto the target drive — backing up an encrypted drive to an unencrypted one silently undoes the feature. Refuse that pairing, or require the target to be encrypted too.
- **The drive label** is readable while locked. That is deliberate (the UI needs it) and should be stated in the setup dialog.
- **Zip downloads** build a temp file in `/tmp` (a 32 MB tmpfs — RAM, and too small for a big folder). Fine, but check the size limit before the vault is involved.

## 8. Phases

| Phase | Work | Why here |
|---|---|---|
| **0** | Fix the LUKS2 profile (cipher, KDF memory, keyslots) and write it down. Decide the second-partition question in §6. | Everything depends on it, cheap to change now |
| **1** | Image: `cryptsetup`, `dm-crypt`, the presence check. Luna: detection, unlock/lock, `locked` column, 423 on API and WebDAV, unlock dialog. | Delivers R1, R4–R7. Testable with real `cryptsetup` |
| **2** | New-drive format path (partition → luksFormat → mkfs.ext4) and the recovery-phrase keyslot. | Needs 1 |
| **3** | `crates/luna-access`: header, Argon2id, AF merge, AES-XTS, ext4, against real cryptsetup volumes. | The critical path; start it early in parallel if possible |
| **4** | Package and sign the reader for three OSes; downloads page. | Delivers R3 |
| **5** | Parity: drive-backup pairing rules, the §7 leak audit, conversion of existing drives. | The long tail |

Conversion of an existing drive is `cryptsetup reencrypt --encrypt`, which works in place, but it is hours on a full drive and needs the last 32 MiB free. **Recommend leaving it out of v1** and offering encryption on new drives only.

## 9. What could kill it

- **The reader.** It is the only way to read the drive and there is no fallback implementation. Underbudgeting it is the main risk in this plan.
- **ext4 inside a container on USB.** ext4 assumes a device that reports write failures honestly. On a cheap stick pulled mid-write, the journal can leave the filesystem needing repair — and there is no `fsck` on a laptop. Mitigate with `data=ordered` and a sync-on-lock, and be honest in the UI about safe removal.
- **Argon2id memory on a 2 GiB box**, competing with the gallery indexer for RAM at exactly the wrong moment.
- **`cryptsetup` as root** on a device node that a member can influence. It parses an attacker-supplied header; run it through `sandbox::hardened` like the other parsers.

## 10. Decisions I need from you

1. **Second partition with the reader binaries?** Recovers the drive-in-a-drawer case cheaply. Changes the layout, so decide before phase 0.
2. **Recovery phrase: yes or no?** It is a second keyslot, so it is cheap to add — but without one, a forgotten password destroys the files.
3. **Who may unlock?** Admin only (my recommendation), or anyone with access to the drive?
4. **Reader: read-only, or read and write?** Read-only is much smaller and covers what you described.
5. **Existing drives, or new ones only?** I recommend new ones only for v1.
