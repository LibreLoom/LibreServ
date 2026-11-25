# Luna cloud archive model

This document records the agreed product behavior for Luna cloud backups. It supersedes conflicting lifecycle behavior in `luna/docs/backups/SPEC.md`. It does not require replacing the current cryptographic, pack, tree, snapshot, or deduplication formats.

## Purpose

The cloud archive is an offsite recovery copy of selected Luna folders. It must remain sufficient to browse and download files after Luna, its database, or all source drives are lost.

Recovery happens through Luna Connect in a browser. There is no restore-into-Luna protocol and no Luna-to-Luna migration.

## Selection and snapshots

- Selecting a folder means archiving that folder's contents over time, including files created inside it later.
- Private items never inherit a parent folder's backup.
- Each successful run creates an immutable snapshot.
- A later edit, deletion, rename, or missing source drive does not modify older snapshots.
- Removing a path from selection does not delete existing snapshots.
- There is one automatic run per day, plus manual **Back up now**.
- A daily run that finds no content changes creates no snapshot.
- A manual run always creates a snapshot, even when content is unchanged.
- Luna keeps the newest seven snapshots total. Manual snapshots count toward the same limit.
- There are no pinned snapshots, day/week/month buckets, paused retention clocks, or mass-delete holds.
- Missing source drives skip the run and leave existing snapshots untouched.
- Deleting an archive is explicit. Physical deletion still uses the existing seven-day Connect safety queue.

## Storage and deduplication

Keep the existing core:

- FastCDC chunking.
- Content deduplication across snapshots.
- Encrypted packs, trees, metadata, and signed snapshot headers.
- Per-recipient sealed key copies and key versions.
- Existing hybrid encryption and signature schemes.
- Browser verification of signatures, hashes, AEAD tags, chunk IDs, and sizes.
- Local and Connect deletion tombstones/grace periods.

Do not rewrite the pack or snapshot format for this work.

To avoid missing same-size/same-mtime edits, each run hashes selected file contents. Deduplication then suppresses uploads for unchanged chunks. The old size/mtime-only reuse fast path is removed.

## Readers and ownership

### Non-private archives

- The Luna Connect admin controls the archive.
- Any authorized Luna admin or user whose phrase-derived key has an envelope can unlock it.
- The Connect admin must still enter a valid recovery phrase to browse contents.
- Share links are scoped to an archive or user and remain revocable.
- A share link alone reveals no file names or contents.

### Private archives

- Only the private-folder owner's key can decrypt.
- The Connect admin cannot decrypt private contents.
- Private records use an opaque namespace derived from the owner's phrase-derived public key, not a clear Luna user ID.
- Connect does not return a list of private namespaces, owners, or private archives before unlock.
- Entering a phrase derives its namespace locally. Connect returns only that namespace's records.
- If nothing opens, Connect shows the same empty state as for any other phrase.
- If records open, all private backups belonging to that phrase are shown together.
- The admin UI always has a stable **Private backups** area; it does not render per-owner rows or reveal whether other people have private backups.
- A private share link is scoped to one private archive and can be unlocked only with the owner's phrase. It does not give a different person decryption ability unless the owner explicitly shares the owner's phrase, which the product does not encourage.

Hiding private records from the admin UI is presentation. Encryption is the security boundary. Connect still sees opaque object metadata such as sizes and timestamps.

## Phrase loss and revocation

- The recovery phrase is the only recovery secret.
- There is no password-based phrase reset for existing archives.
- There is no Connect recovery escrow.
- If a phrase is lost, archives wrapped only to that phrase become inaccessible.
- After Luna and its database are lost, existing snapshots remain available only to readers whose envelopes already exist in Connect. An admin cannot add a new reader to those old snapshots.
- Removing a reader deletes future envelopes and share links. It does not re-encrypt retained snapshots.
- An exposed phrase is handled the same way: issue fresh envelopes for future access and revoke affected links. Keys already extracted by a reader remain able to decrypt old snapshots until those snapshots are deleted.
- Background pack re-encryption/rewrap is removed because cryptographic revocation of extracted keys is not a product promise.

## Correctness fixes required

These are targeted fixes around the existing core, not a format redesign:

1. Add a local publication outbox for normal snapshots so a remote snapshot cannot be published before its local commit and then have its packs cleaned up.
2. Use descriptor-relative no-follow file opening and before/after stability checks so concurrent path replacement cannot escape the selected tree or produce torn files.
3. Make phrase checks validate the sealing key, authentication key, self key, and self-sealed signing public key.
4. Reconcile acknowledged remote key envelopes, recipient records, and self records so a green local check means the browser can actually unlock the archive.
5. Scope publication acknowledgements to the Connect account/device relationship, not only `luna_id`.
6. Remove the dead signed `users/list` record.
7. Do not publish key material for deleted users.
8. Keep private scope cryptography if otherwise unchanged, but remove clear user IDs and owner-list exposure from Connect APIs and UI.

## Out of scope

- New pack or snapshot formats.
- New encryption or signature primitives.
- Cross-snapshot dedup redesign.
- Restore into a replacement Luna.
- Backup migration or import/export protocols.
- Connect-held recovery keys.
- Background cryptographic revocation of already extracted snapshot keys.
- Multi-Luna billing redesign.

## Required tests

- Seven-snapshot retention, including manual snapshots and skipped unchanged daily runs.
- Deleted/missing source files preserve older snapshots.
- Content hashing detects same-size/same-mtime edits while dedup suppresses unchanged uploads.
- Publication crash/lost-acknowledgement recovery.
- No-follow and unstable-file handling.
- Phrase-check validation of all key material.
- Remote envelope/self-record reconciliation.
- Reader removal revokes future access without re-encryption.
- Lost phrase cannot be reset by an admin.
- Private namespace isolation, uniform empty responses, and owner-only unlock.
- Private backups never inherit parent selection.
- No private owner/archive list is exposed before unlock.
