# Encrypted drives — plan for review (2026-11-02)

Planning only. Nothing here is built yet.

## 1. Requirements

- **R1.** Off by default; one option turns encryption on for one drive.
- **R2.** An encrypted drive carries `/blocks` and a reader app per desktop OS.
- **R3.** The reader takes a password and shows the files on a non-Luna computer.
- **R4.** The key lives only in RAM on the Luna.
- **R5.** Someone unlocks the drive after Luna boots.
- **R6.** Web UI access to a locked drive opens an unlock dialog.
- **R7.** API/WebDAV access fails with a code saying "unlock it in the web page".

## 2. The architecture choice

Three different things get called "encrypted drive". They are not variations on one design.

| | **A. Whole-disk (LUKS)** | **B. File-level vault + FUSE** | **C. File-level, no mount** |
|---|---|---|---|
| On the drive | LUKS2 container | Normal filesystem; `blocks/` holds ciphertext | Same as B |
| R2 (`/blocks` + reader) | **No** — a LUKS volume is a raw device, not files | Yes | Yes |
| R3 (read on a laptop) | Needs a LUKS2+ext4 reader for Windows/macOS. Nothing good exists | Yes, our own reader | Yes |
| Luna's file layer | **Unchanged** — marker, microdb, trash, thumbs, private, backups, WebDAV all work | Needs a FUSE server | Rewrite every call site |
| Effort | Small | Large | Very large |

**Recommendation: B.** The only option satisfying R2 and R3, and it leaves Luna's file layer intact — the difference between "a big feature" and "a rewrite". A is the cheap fallback if R2/R3 turn out optional. B's cost sits in one place: **a FUSE server**. Everything above it keeps working because it still sees a normal directory tree.

## 3. What an encrypted drive looks like

```
/blocks/
  header.json          public: format version, vault id, drive id, label,
                       Argon2id params + salt, the wrapped vault key
  tree/<dir-id>.dir    one encrypted directory record per folder
  data/<file-id>.dat   one encrypted container per file
  state.db.enc         the drive's own database (index, photos, trash, albums)
access.exe             Windows reader
access.app             macOS reader (the bare `access` binary lives inside it)
access.appimage        Linux reader
```

`header.json` is the only plaintext file, and holds only what Luna needs to say *"this is a locked drive called Photos"* before anyone unlocks. The label is not a secret — it is already in the clear on every Luna drive.

**Why not reuse the cloud pack layout for `data/`.** That format batches chunks into 32 MiB packs and seals the index beside the body — right for an archive uploaded once, wrong for a live filesystem, where every write would repack and FUSE needs reads at an offset. So `data/<file-id>.dat` is a fixed-block container: 1 MiB blocks, each keyed by the vault key, file id and block index, with an encrypted header holding the block table and size. File names exist only inside the directory records. ~1,500 lines with tests plus a `vectors.json` — the same shape as `backup/cloud/format.rs`.

## 4. Keys

```
password ──Argon2id(salt, m, t)──► KEK ──XChaCha20-Poly1305──► vault key (32 random bytes)
recovery phrase ──BIP39 entropy──► KEK' ─────────────────────► vault key (second copy)
```

- The **vault key** is random, made once, never leaves RAM after unlock.
- `header.json` holds the salt, the Argon2id parameters and one or two wrapped copies of the vault key. No password, no verifier — nothing that lets a guess be tested faster than Argon2id allows.
- The **recovery phrase** is optional and is the same 24-word BIP39 phrase the cloud backup uses. Shown once, never stored. Without it, a forgotten password means the files are gone — the UI must say so before it starts.

**RAM only, and what that means.** R4 holds only if the key never reaches a disk. Build and test that: not in `luna.db`, not in the drive microdb, not in a temp file; `zeroize` on lock and drop; `mlock` the 32 bytes so a page never lands in swap. And **`RLIMIT_CORE = 0` at startup** — a crash today can write a core file containing the key. `sandbox.rs` sets no-core-dumps for children; the daemon itself does not.

## 5. How Luna uses it

Each encrypted drive gets two mounts: the drive's own filesystem at `mounts/drives/<id>` as today, and the FUSE view at `mounts/vaults/<id>` only while unlocked. `drives.mount_point` becomes the **FUSE path**, because that is what every caller means by "the drive root"; the outer path moves to a new `vaults` table that `eject`, `remove` and `reconcile` consult. That is the one invasive change to `drives/mod.rs` — about a dozen call sites, all in one file.

**Do not add a `locked` drive state.** `state` is a string compared against `"as_is"` in ~15 places, and a locked drive is still present and healthy. Add a `locked` column and a `DriveJson` field instead:

- `files::drive_root()` — the one function every file operation already goes through — filters `locked` and returns `FilesError::Locked`
- `map_files_err` turns that into **HTTP 423**, `code: "drive_locked"`, *"This drive is locked. An Admin can unlock it in Luna's web page."*
- `dav_handler_for` gets the same check, so Finder/Explorer show a real error rather than an empty folder
- the drive card shows a `Locked` pill before it considers `isUnopenable`

| When | What happens |
|---|---|
| Boot | `reconcile` mounts the **outer** filesystem, reads `header.json`, marks the drive locked, does not mount the vault |
| Unlock | Argon2id, unwrap the key, mount FUSE, decrypt `state.db.enc` to tmpfs, mark unlocked |
| Lock | Flush, unmount FUSE, zeroize the key, mark locked |
| Eject / remove | Lock first, then unmount the outer filesystem |
| Power off | Nothing to do — the key was only ever in RAM |

**No idle auto-lock in v1.** Gallery indexing, cloud backup and search indexing run against the mount; an idle timer would kill them mid-run and produce "failed" rows nobody caused. Lock on eject, remove and reboot only.

**The unlock dialog (R6).** One global handler, not a check on every page: a `drive_locked` response anywhere opens the dialog for that drive. On success, invalidate the failed queries rather than replaying them. Copy: title `Unlock Photos`, field `Password`, under it *"This drive stays unlocked until you lock it or Luna restarts."*, wrong password shakes with *"That password didn't work."*, five wrong gets *"Too many wrong tries. Wait a few minutes, then try again."*

**Admin only, v1.** A Member with a live session could otherwise sit and guess a password on a drive they can already partly reach. Same rate-limiter pattern as `login_limiter`. Loosening later is a policy change, not a redesign.

## 6. What still leaks — decide this now

This is where the feature's promise goes false if it is skipped.

**The drive microdb.** `.luna-<uuid>.sqlite3` holds `index_entries.name`, `photos.path`, `file_hashes.path`, `albums`, `trash_meta.original_path`. Left on the outer filesystem, a stolen drive hands over the whole tree in plaintext. It must live **inside** the vault.

But SQLite on FUSE is a known way to corrupt a database — it wants POSIX locks, `fsync` ordering and atomic rename. Rather than prove that, keep it **out of the vault's filesystem**: at unlock, decrypt `state.db.enc` into a tmpfs file and open it there; at lock, re-encrypt it back. The microdb is a cache by design, so this fits and is *less* wear. Cost: a power cut can lose recent album and trash metadata — worth a short flush interval and the existing "saving…" state.

**The central database.** `luna.db` is on the Luna's own disk, which this feature does not encrypt, and it records paths in the clear: `user_recents.path` (every file a person opened), `path_moves` (where files went), `access_members`/`access_links.path` (which folders are shared), `protections.source_path` (what is backed up), `jobs.from_path`/`to_path` (what was moved).

So the honest claim is **"someone who steals the Luna can see what files you have, but not what is in them."** Three ways forward:

1. **Accept it and say it** once, in the setup dialog. Cheapest, and true.
2. **Forbid sharing, protection and jobs on encrypted drives in v1.** Clean claim, but removes a lot of the product.
3. **Encrypt those columns.** Correct, and invasive: grants would be unreadable while locked, so the UI could only say "3 people have access" with no paths.

**Recommendation: 1 for v1, 3 as a follow-up.** This decision changes the size of the project.

**Other leaks to close:**

- **Drive backups.** `backup/drive_store.rs` writes plaintext copies onto the target drive — backing up an encrypted drive to an unencrypted one silently undoes the feature. Refuse that pairing or seal the backup with the source vault key.
- **Zip downloads** build a temp file in `/tmp` (a 32 MB tmpfs — RAM, and too small for a big folder). Fine, but check the size limit before the vault is involved.
- **The reader app** parses bytes from a drive that may be hostile. Panic-free and bounds-checked, like the parsers in `sandbox.rs`.

## 7. Reusing the cloud backup mechanism

The answer is "the primitives, not the layout".

| Piece | Reuse? | Why |
|---|---|---|
| XChaCha20-Poly1305 + `canonical` AAD | **Yes** | Same primitive, same helper, same discipline |
| Argon2id | **Yes** | Already a dependency |
| BIP39 phrase | **Yes**, for the optional recovery key | Already used for cloud phrases |
| JS port + `vectors.json` discipline | **Yes** | The reader needs a JS implementation; `shared/ui/lib/cloud/backupCrypto.js` proved the pattern |
| Content-defined chunking | **No** | Built for archival; a live filesystem wants fixed blocks |
| Pack format | **No** | Immutable uploads; every write would repack |
| Hybrid seal (X25519 + ML-KEM) | **No** | Sealing needs a recipient key *pair*; here the opener has a password |
| Signing identity, signed records | **No** | No second party to convince; the AEAD tag proves password and integrity |

So: a new `crates/luna-vault` holds the format and keys with `vectors.json`; `shared/ui/lib/vault/` holds the JS port tested against the same vectors; `lunad`, the FUSE layer and the reader all use the crate.

## 8. The reader app

A small static binary (`crates/luna-access`, ~3–5 MB) that takes a drive path (or finds `blocks/` beside itself), asks for the password, serves a tiny embedded web UI on `127.0.0.1` and opens the browser. The UI reuses the JS port, so there is one crypto implementation to get right and the binary is only a file server. Reuses `desktop/packaging/{windows,appimage,macos}`, which already cross-builds all three from Linux.

**Read-only in v1.** Reading is the whole story you described; writing needs the same crash-safety work twice over.

**Version skew.** Old drives carry old readers. The app refuses an unknown `header.json` version — *"This drive was made by a newer Luna. Get the latest access app from …"* — rather than guessing.

**A drive plugged into a different Luna.** Today an unrecognised drive is offered "Add drive", which would write a `.luna` marker into `blocks/`. `peek`/`inspect` must recognise `blocks/header.json` first and offer *"This is an encrypted Luna drive. Add it, then enter its password."*

## 9. Turning encryption on for an existing drive

Every byte is rewritten, so it is a job with progress:

1. Ask for the password twice, and the recovery key (or an explicit "no recovery key" confirmation).
2. Check free space up front — the vault needs room beside the plaintext. **Require it rather than discovering it halfway.**
3. Lock the drive to other users for the duration (a `converting` flag that `drive_root` refuses like `locked`).
4. Copy into `blocks/`, verify each file by reading it back, then delete the plaintext.
5. Write `header.json` **last**, so a crash leaves a plaintext drive with a `blocks/` folder Luna ignores — never a vault missing files.

Turning it off is the same in reverse. Both need a cancel that leaves the original intact.

## 10. Phases

| Phase | Work | Why here |
|---|---|---|
| **0** | Decide §6 and §12. Write the format as a spec with test vectors. | Everything depends on it, cheap to change now |
| **1** | `crates/luna-vault`: keys, header, directory records, file containers, tests, `vectors.json`. No Luna integration. | Foundation, testable alone, needed by the reader |
| **2** | JS port against the same vectors, then `crates/luna-access` read-only, packaged for three OSes. | Proves the format is portable and delivers R3 before the hard part |
| **3** | Luna: `vaults` table, `locked` column, unlock/lock, FUSE server, `drive_root` gate, 423 on API and WebDAV, unlock dialog. | The big one; everything above it already works |
| **4** | Conversion jobs with progress and cancel. | Needs 3 to have somewhere to put the result |
| **5** | Parity: gallery without inotify, office, cloud backup, drive-backup pairing, the §6 leak audit. | The long tail, where the security claim gets verified |

Phase 3 is the schedule risk. Phases 1–2 are bounded and demonstrable on their own.

## 11. What could kill it

- **FUSE speed on a 2 GiB Wyse over USB 2.0.** Every read costs a userspace decrypt. Thumbnails are already a background job, so photos are probably fine; video streaming and large copies are the ones to measure. **Gate phase 3 on a benchmark** against the same drive unencrypted, and be willing to fall back to A if it is bad.
- **SQLite on FUSE.** Avoided by design in §6, but any path that opens the microdb through the mount instead of the tmpfs copy reintroduces it.
- **Dirty-write loss on power cut.** `ram_cache` already has the vocabulary ("saving…", failed saves). Use it rather than inventing a second notion of "saved".
- **The `access` name.** Your list has both `access` and `access.appimage` — the same Linux program twice. See §12.
- **Image size.** `fuse` must be in the kernel module set and `/dev/fuse` present. The image build already checks that every helper program is present; this needs the equivalent for the module.

## 12. Decisions I need from you

1. **Names or just contents?** Must a stolen Luna hide *which* files you have, or only what is in them? That is §6 — "accept and document" versus "encrypt the path columns".
2. **Reader: read-only, or read and write?** Read-only is much smaller and covers what you described.
3. **Recovery key: yes or no?** Without one, a forgotten password destroys the files.
4. **Who may unlock?** Admin only (my recommendation), or anyone with access to the drive?
5. **The four names.** Is `access` a separate Linux binary from `access.appimage`, or the macOS bundle's inner binary?
6. **Existing drives, or new ones only?** Converting a full 1 TB drive is hours and needs the free space up front. Restricting v1 to drives added after this ships removes the riskiest job.
