# Encrypted drives — plan for review (2026-11-02)

Planning only. Nothing here is built yet.

## 1. What you asked for

Restated as requirements, so the rest of this document can be checked against them:

- **R1.** Off by default. An option somewhere turns encryption on for one drive.
- **R2.** An encrypted drive carries `/blocks` and a reader app for each desktop OS.
- **R3.** The reader app takes a password and shows the decrypted files on a computer that is not a Luna.
- **R4.** The password (or what it unlocks) lives only in RAM on the Luna. Stealing the box and the drive gets nobody the files.
- **R5.** Someone must unlock the drive after Luna boots.
- **R6.** Any attempt to reach a locked drive from the web UI opens an unlock dialog.
- **R7.** Any attempt over the API or WebDAV fails with a code that says "unlock it in the web page".

## 2. The architecture choice, and what it costs

"Encrypted drive" can mean three quite different things. They are not variations on one design; they have different costs and different stories.

| | **A. Whole-disk (LUKS)** | **B. File-level vault + FUSE** | **C. File-level vault, no mount** |
|---|---|---|---|
| What's on the drive | A LUKS2 container; the filesystem lives inside it | The drive keeps its filesystem; `blocks/` holds ciphertext | Same as B |
| R2 (`/blocks` + reader apps) | **No** — a LUKS volume is a raw device, not files | Yes | Yes |
| R3 (read it on a laptop) | Needs a LUKS2 + ext4 reader for Windows/macOS. Nothing good exists; VeraCrypt does not read LUKS | Yes, our own reader | Yes |
| Luna's file layer | **Unchanged.** Marker, microdb, trash, thumbs, private items, backups, WebDAV all just work | Needs a FUSE server | Needs a rewrite of every file call site |
| Effort | Small (cryptsetup + unlock UI) | Large | Very large |
| R4 holds | Yes, while powered off | Yes | Yes |

**Recommendation: B.** It is the only one that satisfies R2 and R3, and it keeps Luna's file layer intact — which is the difference between "a big feature" and "a rewrite". A is worth knowing about as the cheap option if R2/R3 turn out to be optional.

The cost of B is concentrated in one place: **a FUSE server**. Everything above it (index, gallery, office, WebDAV, jobs, backups, private items, path jail) keeps working because it still sees a normal directory tree.

## 3. What an encrypted drive looks like

```
/blocks/
  header.json          public: format version, vault id, drive id, label,
                       Argon2id parameters and salt, the wrapped vault key
  tree/<dir-id>.dir    one encrypted directory record per folder
  data/<file-id>.dat   one encrypted container per file
  state.db.enc         the drive's own database (index, photos, trash, albums)
access.exe             Windows reader
access.app             macOS reader (the bare `access` binary lives inside it)
access.appimage        Linux reader
```

`header.json` is the only plaintext file, and it holds only what Luna needs to say *"this is a locked drive called Photos"* before anyone unlocks it. The label is not a secret — it is already written in the clear on every Luna drive today.

**Why not reuse the cloud backup pack layout for `data/`.** The cloud format batches many chunks into one 32 MiB pack and seals the index beside the body. That is right for an archive uploaded once and read whole, and wrong for a live filesystem: every write would repack, and FUSE needs to read and write at an offset. So `data/<file-id>.dat` is a fixed-block container instead:

- block size 1 MiB, so a read at an offset decrypts one block, not the file
- block key = `HKDF(vault key, "luna-vault-block-v1", file-id ‖ block-index)`, fixed nonce. The key changes per block, so no nonce can ever repeat — no random-nonce collision to reason about.
- the file's block table, size and times sit in an encrypted header under `HKDF(vault key, "luna-vault-meta-v1", file-id)`, with AAD binding the file id and vault id
- a directory record is an encrypted map of `name → (kind, id, size, mtime)`; file names exist only inside these records

That is ~1,500 lines of new code with tests, plus a `vectors.json` — the same shape as `backup/cloud/format.rs`, which is a good sign it is the right size.

## 4. Keys

```
password ──Argon2id(salt, m, t)──► KEK ──XChaCha20-Poly1305──► vault key (32 random bytes)
recovery phrase ──BIP39 entropy──► KEK' ─────────────────────► vault key (second copy)
```

- The **vault key** is random, made once, and never leaves RAM after unlock.
- `header.json` holds the salt, the Argon2id parameters, and one or two wrapped copies of the vault key. It holds no password, no verifier, and nothing derived from the vault key that would let someone test a guess faster than Argon2id allows.
- The **recovery phrase** is optional and is the same 24-word BIP39 phrase the cloud backup already uses (`crypto::phrase_to_entropy` / `entropy_to_phrase`). It is shown once, never stored on the Luna, and wraps a second copy of the vault key. Without it, a forgotten password means the files are gone — and the UI has to say that in those words before it starts.
- Unlocking is one Argon2id run plus one AEAD open. A wrong password fails the AEAD tag; there is no separate check value to leak.

**RAM only, and what that means.** R4 is true only if the vault key never reaches a disk. That is a property to build and test, not a comment:

- not in `luna.db`, not in `meta`, not in the drive microdb, not in a temp file
- `zeroize` on lock and on drop; the key sits in a `Zeroizing<[u8; 32]>` inside the vault registry
- `mlock` the 32 bytes so a page never lands in swap. Luna OS has no swap today (`/etc/fstab` has none) — this is belt and braces for dev hosts.
- **`RLIMIT_CORE = 0` at startup.** A crash today can write a core file containing the key. `sandbox.rs` already sets no-core-dumps for child processes; the daemon itself does not.
- `/tmp` is a 32 MB tmpfs in the image, so a stray temp file is RAM anyway — but the code must not rely on that.

## 5. How Luna uses it

### Mounts

Each encrypted drive gets two mounts:

```
/var/lib/luna/mounts/drives/<drive-id>    the drive's own filesystem (exFAT/ext4), as today
/var/lib/luna/mounts/vaults/<drive-id>    the FUSE view, only while unlocked
```

`drives.mount_point` becomes the **FUSE path**, because that is what every existing caller means by "the drive root". The outer path moves to a new `vaults` table (`drive_id`, `outer_mount_point`, `vault_id`, `created_at`), which `eject`, `remove` and `reconcile` consult. This is the one invasive change to `drives/mod.rs`: roughly a dozen call sites, all in one file.

### Drive state

**Do not add a `locked` drive state.** `state` is a single string compared against `"as_is"` in about fifteen places, and a locked drive is still a present, mounted, healthy drive. Add a `locked` column and a `locked` field on `DriveJson` instead. Then:

- `files::drive_root()` — the one function every file operation already goes through — filters `locked` and returns `FilesError::Locked`
- `map_files_err` turns that into **HTTP 423** with `code: "drive_locked"` and the message *"This drive is locked. An Admin can unlock it in Luna's web page."*
- `dav_handler_for` gets the same check, so WebDAV answers 423 and Finder/Explorer show a real error rather than an empty folder
- `api/drives.rs` reports `locked`, and the drive card shows a `Locked` pill before it considers `isUnopenable`

### Lifecycle

| When | What happens |
|---|---|
| Boot | `reconcile` mounts the **outer** filesystem, reads `header.json`, marks the drive `locked`, and does not mount the vault. No prompt, no queue of work. |
| Unlock (web UI) | Argon2id, unwrap the vault key, mount FUSE, decrypt `state.db.enc` into a tmpfs file, mark `locked = false`. |
| Lock | Flush dirty writes, unmount FUSE, drop and zeroize the key, mark `locked = true`. |
| Eject / remove | Lock first, then unmount the outer filesystem. |
| Power off | Nothing to do — the key was only ever in RAM. |

**No idle auto-lock in v1.** Background work (gallery indexing, cloud backup, search indexing) runs against the mount; an idle timer would kill it mid-run and produce "failed" rows nobody caused. Lock on eject, remove, and reboot only. A later "lock after N hours" can be added once the background work knows how to pause.

### The unlock dialog (R6)

One global handler, not a check on every page: a `drive_locked` response anywhere in the web app opens the unlock dialog for that drive. On success, invalidate the queries that failed rather than replaying the request — simpler, and the page refetches anyway.

Copy, following the plain-language rules:

- Title: `Unlock Photos`
- Field: `Password`
- Line under it: `This drive stays unlocked until you lock it or Luna restarts.`
- Wrong password: shake, `That password didn't work.`
- Five wrong: `Too many wrong tries. Wait a few minutes, then try again.`

### Who may unlock

**Admin only, for v1.** A Member with a live session could otherwise sit and guess a password on a drive they can already partly reach. The unlock endpoint goes through the same rate limiter pattern as `login_limiter` (per user, per drive). If it turns out households need a Member to unlock, that is a policy change, not a redesign — but the default should be the narrow one.

## 6. What still leaks, and why you should decide it now

This is the part of the plan most likely to make the feature's promise false if it is skipped.

**The drive microdb.** `.luna-<uuid>.sqlite3` holds `index_entries.name`, `photos.path`, `file_hashes.path`, `albums`, `trash_meta.original_path`. If it stays on the outer filesystem, a stolen drive hands over the complete file tree in plaintext. So it must live **inside** the vault.

But SQLite on FUSE is a known way to corrupt a database: it wants POSIX locks, `fsync` ordering, and atomic rename, and FUSE delivers those only if the server is careful. Rather than prove that, keep the microdb **out of the vault's filesystem entirely**: at unlock, decrypt `state.db.enc` into a tmpfs file and open it there; at lock or on a timer, re-encrypt it back. The microdb is a cache by design ("must not wear the OS eMMC"), so this fits, and it is *less* wear, not more. The cost is that a power cut can lose recent album and trash metadata — worth a short flush interval and the existing "saving…" state.

**The central database.** `luna.db` is on the Luna's own disk, which this feature does not encrypt. It records paths in the clear in several tables:

| Table | Column | What it reveals |
|---|---|---|
| `user_recents` | `path` | every file a person opened |
| `path_moves` | `old_path`, `new_path` | where files went |
| `access_members`, `access_links` | `path` | which folders are shared |
| `protections` | `source_path` | which folders are backed up |
| `jobs` | `from_path`, `to_path` | what was moved or copied |

So the honest claim is **"someone who steals the Luna can see what files you have, but not what is in them."** Three ways forward:

1. **Accept it and say it.** The UI states it once, in the encryption setup dialog. Cheapest, and true.
2. **Forbid sharing, protection and jobs on encrypted drives in v1.** Makes the claim clean, but removes a lot of the product.
3. **Encrypt those columns for encrypted drives.** Correct, and invasive: grants and protections would be unreadable while the drive is locked, so the UI could only say "3 people have access" with no paths.

**Recommendation: 1 for v1, with 3 as a follow-up if names must be secret.** This is the single decision that changes the size of the project, and it is yours to make — see §12.

**Other leaks to close:**

- **Drive backups of an encrypted drive.** `backup/drive_store.rs` writes plaintext copies onto the target drive. Backing up an encrypted drive to an unencrypted one silently undoes the feature. Either refuse that pairing or seal the backup with the source vault key.
- **Thumbnails and shared-album copies** live under the drive root, so inside the vault — fine. The browser cache is the client's problem; `Cache-Control: private, no-store` is already set on content responses.
- **Zip downloads** are built in a temp file (`api/files.rs`), which on the Luna is a 32 MB tmpfs — RAM, and too small for a big folder. Fine, but the size limit should be checked before the vault is involved.
- **The access app** parses bytes from a drive that may be hostile. It must be panic-free and bounds-checked, like the sandboxed parsers in `sandbox.rs`.

## 7. Reusing the cloud backup mechanism — what actually transfers

You were right to ask, and the answer is "the primitives, not the layout".

| Piece | Reuse? | Why |
|---|---|---|
| XChaCha20-Poly1305 + `canonical` AAD | **Yes, directly** | Same primitive, same helper, same discipline |
| Argon2id | **Yes** | Already a dependency for passwords |
| BIP39 recovery phrase | **Yes**, for the optional recovery key | `phrase_to_entropy` / `entropy_to_phrase` |
| JS port + `vectors.json` discipline | **Yes** | The reader app and any browser reader need a JS implementation, and this repo has already proved that pattern with `shared/ui/lib/cloud/backupCrypto.js` |
| Content-defined chunking (`fastcdc`) | **No** | Built for archival; a live filesystem wants fixed blocks |
| Pack format (wrapped key, sealed index, body) | **No** | Immutable uploads; every write would repack |
| Hybrid seal (X25519 + ML-KEM) | **No** | Sealing needs a recipient key *pair*. Here the opener has a password, not a key pair — Argon2id + AEAD is the right shape. |
| Signing identity, signed records | **No** | There is no second party to convince; the AEAD tag already proves the password and the integrity |

So: a new `crates/luna-vault` holds the format and the keys, with `vectors.json`; `shared/ui/lib/vault/` holds the JS port tested against the same vectors. `lunad`, the FUSE layer and the reader app all use the crate.

## 8. The reader app

A small static binary (`crates/luna-access`, ~3–5 MB) that:

1. takes a path to a drive (or finds `blocks/` beside itself),
2. asks for the password,
3. serves a tiny embedded web UI on `127.0.0.1` and opens the browser.

The UI reuses the JS port, so there is one crypto implementation to get right, and the binary is only a file server plus the embedded page. It reuses the existing packaging pipeline (`desktop/packaging/{windows,appimage,macos}`), which already cross-builds all three targets from Linux.

**Read-only in v1.** Reading is the whole story you described, and writing needs the same crash-safety work as Luna's side, twice over.

**Version skew.** Old drives carry old reader apps. `header.json` has a version byte, and the app must refuse an unknown version with *"This drive was made by a newer Luna. Get the latest access app from …"* rather than guessing.

**A drive plugged into a different Luna.** Today, an unrecognised drive is offered "Add drive", which would write a `.luna` marker into `blocks/`. `peek` and `inspect` must recognise `blocks/header.json` first and offer *"This is an encrypted Luna drive. Add it, then enter its password."*

## 9. Turning encryption on for an existing drive

Every byte has to be rewritten, so this is a job with progress, not a request:

1. Ask for the password twice, and the recovery key (or an explicit "no recovery key" confirmation).
2. Check free space: the conversion needs room for the vault beside the plaintext, or a streaming rewrite that cannot be resumed. **Require the space up front** rather than discovering it halfway.
3. Lock the drive to other users for the duration (read-only, or a `converting` flag that `drive_root` refuses like `locked`).
4. Copy into `blocks/`, verify each file by reading it back, then delete the plaintext.
5. Write `header.json` **last**, so a crash leaves a plaintext drive with a `blocks/` folder that Luna ignores — never a vault that is missing files.

Turning it off is the same job in reverse. Both need a cancel that leaves the original intact.

## 10. Phases

| Phase | Work | Why here |
|---|---|---|
| **0** | Decide §6 (names) and §12. Write the format down as a spec with test vectors. | Everything else depends on it, and it is cheap to change now |
| **1** | `crates/luna-vault`: keys, header, directory records, file containers, tests, `vectors.json`. No Luna integration. | The foundation, testable alone, and the thing the reader app needs |
| **2** | `shared/ui/lib/vault/` JS port against the same vectors. Then `crates/luna-access`, read-only, packaged for three OSes. | Proves the format is portable and delivers R3 before the hard part |
| **3** | Luna: `vaults` table, `locked` column, unlock/lock, FUSE server, `drive_root` gate, 423 on API and WebDAV, unlock dialog. | The big one. Everything above it already works |
| **4** | Conversion jobs (enable/disable) with progress and cancel. | Needs 3 to exist to have somewhere to put the result |
| **5** | Parity: gallery indexing without inotify, office, cloud backup, drive-backup pairing rules, the leak audit from §6. | The long tail, and where the security claim gets verified |

Phase 3 is where the schedule risk is. Phases 1 and 2 are bounded and produce something demonstrable on their own.

## 11. What could kill it

- **FUSE speed on a 2 GiB Wyse over USB 2.0.** Every read now costs a decrypt in userspace. Thumbnails are already a background job, so photos are probably fine; video streaming and large-file copies are the ones to measure. **Gate phase 3 on a benchmark** against the same drive unencrypted, and be willing to fall back to option A if it is bad.
- **SQLite on FUSE.** Avoided by design in §6, but any code path that opens the microdb through the mount path instead of the tmpfs copy reintroduces it.
- **Dirty-write loss on power cut.** `ram_cache` already has the vocabulary for this ("saving…", failed saves). The vault must use it rather than inventing a second notion of "saved".
- **The `access` name.** Your list has both `access` and `access.appimage`, which are the same Linux program twice. See §12.
- **Image size.** `fuse` must be in the kernel module set and `/dev/fuse` present. The image build already has a "every helper program lunad needs is in the image" check; this needs an equivalent for the module.

## 12. Decisions I need from you

1. **Names or just contents?** Does a stolen Luna need to hide *which files* you have, or only what is in them? That is §6, and it is the difference between "accept and document" and "encrypt the central database's path columns".
2. **Reader app: read-only, or read and write?** Read-only is much smaller and covers what you described.
3. **Recovery key: yes or no?** Without one, a forgotten password destroys the files. With one, the user must keep a 24-word phrase somewhere off the Luna.
4. **Who may unlock?** Admin only (my recommendation), or anyone with access to the drive?
5. **The four names.** Is `access` meant to be a separate Linux binary from `access.appimage`, or the macOS bundle's inner binary?
6. **Existing drives, or new ones only?** Conversion of a full 1 TB drive is hours and needs the free space up front. Restricting v1 to drives added after the feature ships removes the riskiest job.
