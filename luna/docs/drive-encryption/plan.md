# Encrypted drives — plan (2026-11-02)

**LUKS2 + ext4, Luna side only.** The computer-side reader is deferred (§7).

> **Status: built.** Phases 0–4 are implemented. The design changed while
> building it: encryption is turned on and off by **reformatting the drive**,
> not by converting it in place. §5 explains why, and what the earlier in-place
> design got wrong. Phase 5 (§8) is still open.

## 1. Scope

Built:

- **R1.** Off by default; one option turns encryption on for one drive — and off again, on any drive, at any time. Both directions wipe the drive.
- **R4.** The key lives only in RAM on the Luna.
- **R5.** Someone unlocks the drive after Luna boots.
- **R6.** Web UI access to a locked drive opens an unlock dialog.
- **R7.** API/WebDAV access fails with a code saying "unlock it in the web page".

Deferred: reading the drive on a non-Luna computer. Until the reader exists, an encrypted drive is readable only by a Luna. That is a real product limit, not a detail — an encrypted drive is not a portable archive yet.

**Encrypted drives are always ext4 inside a LUKS2 container.** Getting there wipes the drive, so the filesystem it had before does not matter — any drive Luna can see can be encrypted.

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

**The LUKS2 profile is frozen** (`drives/luks.rs`): single cipher `aes-xts-plain64`, 512-bit key, `argon2id`, no `dm-integrity`, 512-byte sectors. Once drives exist in the wild, changing this breaks every future reader.

**No post-quantum layer here, deliberately.** See §4a.

## 4. Keys

**One keyslot, one password. No recovery path.**

| Keyslot | Opened by |
|---|---|
| 0 | the drive password |

`luksFormat` makes a random 512-bit volume key and wraps it in keyslot 0 under the password the user types. The password does not encrypt anything itself — it unwraps the volume key. We never handle the volume key directly, so there is no custom key-wrapping code.

**Why no second keyslot.** The obvious candidate is a recovery key, and it does not survive scrutiny. A random string written on paper and a password written on paper are the same artifact with the same failure mode: whoever finds the paper opens the drive, and whoever loses it has nothing. A separate slot only adds one real property — it survives a password change — and the answer to that is "if you change the password, change the paper." There is no scenario where the second slot earns its keep, and it would drag in the cloud recovery phrase, which is per-user and bound to the Luna id (§4b).

So the honest statement is: **if the password is forgotten, the files on this drive are gone. Nobody can recover them, including us.** That is what a locked safe is. The safety mechanism is making the person read that before the format runs — see §5.

- **The passphrase is never an argument.** `cryptsetup luksOpen --key-file -` reads stdin; anything on the command line is world-readable in `/proc/<pid>/cmdline`.
- **After unlock, no key is kept in userspace at all.** The volume key lives in the kernel's dm-crypt, which is not swappable and is wiped by `luksClose` or power loss. R4 holds more cleanly than holding a key in a process.
- **Argon2id memory is lowered.** LUKS2 defaults to 1 GiB, which OOM-kills on a 2 GiB Wyse ([docs](https://man7.org/linux/man-pages/man8/cryptsetup-luksFormat.8.html), [writeup](https://sleeplessbeastie.eu/2021/07/05/how-to-open-luks2-encrypted-volume-on-a-low-memory-device/)). `luks::pbkdf_kib_from` takes an eighth of free RAM from `budget::meminfo()`, clamped to 32 MiB–1 GiB, and records it in the header.
- **`RLIMIT_CORE = 0` at startup.** dm-crypt keys aren't in the daemon's address space, but the passphrase passes through it. `sandbox.rs` sets no-core-dumps for children; the daemon itself does not.


### 4a. Post-quantum: not applicable here, and that is correct

Luna already ships hybrid post-quantum crypto for cloud backup — X25519 + ML-KEM-768 for sealing, Ed25519 + ML-DSA-65 for signing (`backup/cloud/crypto.rs`). It is reasonable to ask why drives don't get the same treatment. The answer is that the two problems are not the same shape.

**What quantum computers actually break is asymmetric crypto** — key agreement and signatures. Shor's algorithm kills X25519 and Ed25519 outright, which is why cloud backup needs ML-KEM and ML-DSA alongside them: a backup sealed today might be opened by an attacker in 2040, and the sealed copy holds the ciphertext that attacker would harvest now.

**Symmetric crypto survives with a smaller key.** Grover's algorithm gives a quadratic speedup on brute force, so AES-256 keeps roughly 128 bits of security — still far out of reach ([analysis](https://arxiv.org/pdf/2502.02445)). LUKS2's `aes-xts-plain64` with a 512-bit key is AES-256, which is exactly the size that survives. There is no asymmetric step anywhere in unlocking a drive: Argon2id turns a password into a key, and AES does the rest. Nothing for Shor's algorithm to attack.

**So the drive is already post-quantum-safe in the way that matters**, and adding ML-KEM would mean inventing a container format — because LUKS2 has no post-quantum cipher option, and `cryptsetup` only speaks the ciphers the kernel's dm-crypt provides. That would cost the entire advantage of using LUKS2: a standard format, a well-tested implementation, and a reader that is tractable to write.

**Not doing:** ML-KEM wrapping of the volume key, ML-DSA signatures on the header, or a custom container. If LUKS2 gains post-quantum ciphers later, drives can be re-encrypted then — which is a reason to keep the format standard, not to invent one now.

### 4b. The cloud recovery phrase is not usable here

Worth recording, because it is the obvious thing to reach for and it does not work.

- **It is per-user, and a drive is per-household.** `user_keys` is keyed by `user_id`, and the phrase is derived in the browser and never reaches Luna. "The drive's phrase" is not a thing that exists — it would be one person's phrase, and it would leave with them.
- **Its derivation is bound to the Luna id.** `derive_info` mixes `luna_id` into every HKDF label, deliberately, so one Luna's sealed copies cannot be opened by another. For a drive that is exactly backwards: the point of a recovery path is that it works on a *replacement* Luna.
- **It is a key-derivation seed, not a passphrase.** Cloud backup derives X25519 + ML-KEM + signing keys from it. LUKS2 wants a byte string for Argon2id. Making the same words do both jobs means two unrelated derivations behind one artifact, and a confusing error when someone types them into the wrong dialog.

Reusing it would also change the cloud flows, which are currently built entirely around cloud backup. Not worth it for a recovery path we are not building.

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

**Anyone with access to the drive may unlock it.** If a person can read the drive's files, they already have everything the password protects, so withholding the unlock button buys nothing — the password is shared the way a house key is. It does mean a Member with a live session can guess, so the endpoint keeps the `login_limiter` rate-limit pattern: per user, per drive, five tries then a wait. A Member who has no access never sees the dialog, because `drive_root()` refuses them before `locked` is consulted.

**No idle auto-lock in v1** — gallery indexing, cloud backup and search indexing run against the mount, and an idle timer would kill them mid-run. Locking is an explicit action on the encryption page (§5).

### Encryption mode — one place per drive

Not buttons beside Eject. Encryption is a long, irreversible operation, so it gets a **destination of its own**: `/files/:id/encryption`, reachable from the drive card.

A route rather than a modal, for three reasons: progress survives a refresh and a navigation; it is a place you return to rather than a dialog you dismiss; and it can hold the state, the history and the actions together instead of scattering them.

**What the page shows**, in one column:

| State | What it says | What you can do |
|---|---|---|
| Unencrypted | *"Files on this drive are not encrypted. Anyone who plugs it in can read them."* | Encrypt |
| Encrypting | Progress bar, and *"Being encrypted. This drive is unavailable until that finishes."* | nothing (cancel is deferred) |
| Encrypted, locked | *"Locked. Enter the password to open it."* | Unlock |
| Encrypted, unlocked | *"Unlocked. It stays open until you lock it or Luna restarts."* | Lock, Decrypt |
| Decrypting | Progress bar, *"Decrypting"* | nothing |

`encryptionState()` in `web/src/lib/encryption.js` owns the precedence, so the page and its tests cannot disagree.

**Cancel is not built, and matters less now.** A format is bounded by the drive's metadata rather than its contents, so the window in which cancelling would help is seconds, not hours. The drive is held exclusively either way, so a cancel would have to leave it in a state the UI can describe; the honest answer today is that it runs to completion.

The page is the only home for progress. The drive card shows a one-line state (`Encrypting`, `Locked`, `Unlocked`) and a link here — enough to know what is happening, not enough to act by accident. The link appears on the Files page only; the dashboard card stays a summary.

**Encrypt and Decrypt both go through a confirmation step** on this page, never directly from the card. Encrypt asks for the password twice, with the §4 warning above the fields. **Decrypt asks for the password too** — it proves the person knows it rather than merely sitting at an unlocked session, and it is the last moment before the files become readable by anyone who plugs the drive in. Its confirmation says exactly that.

**Turning encryption on or off wipes the drive.** There is no in-place conversion. The drive is reformatted — keeping its identity — and whatever was on it is gone. That is a deliberate reversal of the earlier design, and the reason is below.

**Blocking the drive while it runs.** The format holds the drive exclusively: `Db::drive_lock` for per-drive writes, `begin_closing` so `reconcile` leaves it alone, and a `converting` flag that `drive_root()` refuses the way it refuses `locked` — same 423, different message. Browse, uploads, WebDAV, gallery indexing and backups all stop for the duration, because they all go through `drive_root()`.

**Why not convert in place.** The earlier plan converted ext4 in place with `cryptsetup reencrypt`. It worked, and it was verified end to end on real devices — but it had three problems that were not worth carrying:

- **Only ext4 could do it.** `reencrypt` needs the filesystem shrunk by the header size first (it does not shrink it itself — skipping that step destroys the filesystem while reporting success, measured on loop devices). Only ext4 can be shrunk; exFAT, FAT32 and NTFS have no shrink tool, so most drives — which are exFAT — were refused.
- **The interrupted state was broken.** `luksDump` on a real interrupted conversion (cryptsetup 2.7.0) prints `Requirements: online-reencrypt-v2` and a `1: reencrypt (unbound)` keyslot. It does **not** print an `Online reencryption` block, which is what the parser looked for. Three real interrupted dumps all parsed as `None`, so the drive looked healthy and the Resume button never appeared; `luksOpen` then failed with `Reencryption in-progress. Cannot activate device.` and the raw developer string reached the user. Recovery needed `cryptsetup repair`, which was never called.
- **Hours of anxiety for a result a format gives in seconds.** A wipe plus `mkfs` is bounded by the size of the drive's metadata, not its contents.

Wiping also removes the whole class of "the drive is half-converted" states: a format either finishes or the drive has no filesystem, and both are states the UI already knows how to describe.

**One backend.** `drives/format.rs` is the only thing that puts a filesystem on a drive. Every flow goes through it — adding a blank stick, erasing installer media, reformatting an existing drive, turning encryption on, turning it off — and they differ only in the `Target` they ask for:

| Target | Filesystem | Container |
|---|---|---|
| `Target::plain(label)` | exFAT (FAT32 fallback) | none |
| `Target::encrypted(label)` | ext4, forced | LUKS2 |

The sequence is always: unmount everything on the disk and refuse if anything is still busy → `wipefs` every signature → one partition spanning the disk → optionally `luksFormat` → `mkfs` on the partition or on the mapper. An encrypted target forces ext4 rather than taking the caller's word for it, because an encrypted drive is always ext4 inside.

**The wipe confirmation is one dialog, in one place.** `WipeDriveDialog` is used by every flow that destroys a drive, and it enforces one rule:

- A drive holding **nothing meaningful** gets a single confirmation.
- A drive holding **anything** gets the same confirmation with the button disabled for **30 seconds**, and the dialog lists what is on the drive.

"Meaningful" is measured, not guessed: used bytes beyond what a fresh filesystem of that kind already occupies. A freshly made 2 TB exFAT reports 2.25 MiB used with nothing on it, a 200 GB one 512 KiB, a 4 GB one 96 KiB, and a fresh ext4 28 KiB at any size — so the allowance is 16 MiB, generous enough to separate "empty" from "has files" in either direction. A drive Luna could not read is treated as holding something, because the alternative is telling someone a drive is empty when it is not. `drives/wipe.rs` owns the measurement and the rule; the API exposes it as `GET /api/v1/drives/{id}/wipe-preview`.

**Reformatting keeps the drive's identity.** The wipe destroys the `.luna-<uuid>` marker, and the marker is what ties the drive on disk to its row in `luna.db` — its shares, access grants, gallery index and backup rules. So the job remounts the drive, rewrites the same marker with the same id, and records the new mount point. Without that step a reformatted drive would look like a stranger and every grant would silently detach.

**Decrypt still asks for the password.** It is about to be destroyed, but asking proves the person knows it rather than merely sitting at an unlocked session, and it is the last moment before the files become readable to anyone who plugs the drive in. `POST /reformat` (the plain "start over" path) is refused on an encrypted drive for the same reason.

**Admin-only**, matching Remove and Eject. A Member can use an encrypted drive and unlock it, but cannot change whether it is encrypted.

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

| Phase | Work | State |
|---|---|---|
| **0** | Fix the LUKS2 profile (cipher, KDF memory, one keyslot). | done — `drives/luks.rs` |
| **1** | Image: `cryptsetup`, `dm-crypt`, presence check. Luna: detection, unlock/lock, `locked` column, 423 on API and WebDAV. | done |
| **2** | The encryption page: route, the five states, Unlock/Lock, the drive-card link and state line. | done |
| **3** | New-drive format path: partition → `luksFormat` → `mkfs.ext4`, reusing the page's password step. | done |
| **4** | Encryption both ways by reformatting: one format backend, the shared wipe confirmation with its 30-second rule, identity preserved across a wipe, the `converting` flag and the exclusive hold. | done |
| **5** | Parity: drive-backup pairing rules, the §6 leak audit. | **not done** |

Phase 5 is the remaining work. Two things in §6 are still open and are the reason it is not "finished":

- **Drive backups can undo encryption.** `backup/drive_store.rs` writes plaintext copies onto the target drive, so backing up an encrypted drive to an unencrypted one silently defeats the feature. Nothing refuses that pairing yet.
- **The central database still records paths in clear.** Accepting that is a decision, but the UI should not imply more than it delivers.

**Still to verify on real hardware** (not assumptions, and not covered by the unit tests):

- That a real wipe on a real stick produces a drive Luna can immediately browse, share and back up — the unit tests use a mock probe, so the whole sequence has only been exercised against loop devices by hand.
- That a power cut during the format leaves the drive recoverable. The `converting` flag is cleared at startup (`db::open`), so the drive is not locked out of the UI; what it comes back as depends on how far the wipe got, and the UI has no state for "no filesystem" beyond the existing unreadable-drive handling.
- That a LUKS2 container created by this code opens on a machine that is not a Luna, which is the whole point of the deferred reader.

## 9. Settled

- **Anyone with access to a drive may unlock it.** The rate limiter is what makes that safe.
- **Encryption is turned on and off by wiping the drive**, not by converting it in place. Any drive Luna can see can be encrypted, whatever filesystem it has now. Encrypted drives are always ext4 inside a LUKS2 container.
- **A wipe keeps the drive's identity.** The same id and a fresh marker, so shares, grants, gallery index and backup rules survive.
- **One confirmation for an empty drive; a 30-second wait for one holding anything**, with the contents listed. The rule is the same for every flow that wipes.
- **The drive is locked after an encrypted format.** The key went with the job, so the password is entered again — which also proves it was recorded correctly.
- **Decrypt requires the password.**
- **The encryption page is linked from the Files page only**; the dashboard card stays a summary.
- **No recovery path.** One keyslot, one password, and the warning says what that means.
