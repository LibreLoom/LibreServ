# Phase 3 plan: Connect web UI, browser decryption, share links, Luna restore after DB loss

Plan: `/var/home/plainskill/.claude/plans/protect-rebuild.md` §5 Keys, §5 "Luna loses its database", §6, §9 Connect, §10.3.
Every implementer also reads `brief-common.md` (same folder). Web tasks also read `AGENTS.md` (Plain language, Frontend, Design).

## Waves

| Wave | Tasks (parallel inside a wave) | Needs |
|---|---|---|
| 0 | **T0** move `backupCrypto.js` to `shared/ui/lib/cloud/`, add deps. Then the ORCHESTRATOR runs `npm install` in `shared/ui` and `luna/connect/web` (workers may not) and checks `npx vitest run` in shared/ui, luna/web, luna/connect/web | - |
| 1 | **R1** Rust: `started_by_name` in BackupMeta + cross-language fixture. **R2** Rust: Luna restore API. **G1** Connect: tear down backup_objects/bindings, schema additions | T0 not needed |
| 2 | **G2** Connect: 30-day purge after unbind, retention via PurgeStorage. **G3** Connect: account read API. **W1** shared JS: keys + format decryptors (tests on R1's fixture). **WZ** Connect web: zip writer + tree helpers (`luna/connect/web/src/lib`) | G1 (G2, G3), R1+T0 (W1), T0 (WZ) |
| 3 | **G4** Connect: share links. **W2a** Connect web: data layer (sources, unlock, downloads). **W4** Luna web: restore card | G3 (G4), W1+WZ (W2a, W4), R2 (W4 contract only) |
| 4 | **W2b** Connect web: UnlockCard, CloudBrowser, Backups page; remove BackupBrowser/backupTree/fileKinds | W2a (imports its files; must not start before W2a reports) |
| 5 | **W3** Connect web: share-link UI + share page | W2b, G4 |

13 tasks in 6 waves (T0 is small setup). Kept small on purpose for Haiku.

File ownership is exclusive per wave. One owner per shared file over the whole phase:
`server.go`: G1 (remove), then G3 (add read routes), then G4 (add share routes). `schema.go`: G1 only. `App.jsx`: W3 only. `api.js` (connect web): W2b only. `BackupsPage.jsx`: W2b, then W3. `CloudBackupCategory.jsx` (luna web): W4 only. lunad `api/mod.rs`: R2 only. `backup/cloud/mod.rs`: R1 only.

## Decisions taken in this plan (tell the user)
1. **Names for "browse by user".** `BackupMeta` gains `started_by_name` (encrypted under the backup key, like the rest of meta). `started_by` becomes the protection's creator (`row.created_by`), not the run trigger. Connect never sees names in plain.
2. **Key copies found through the signed recipients records, not by the user's current id.** After DB loss a person gets a new user id. The browser reads every `recipients/<prot>.<ver>` record and tries the copy of each listed user id (`keys/<prot>.<ver>.<part(uid)>`) until one opens. It finds its `self/<part>` record the same way. The signed `users/list` is not needed by browsers.
3. **Browser crypto is shared, not forked.** `backupCrypto.js` moves to `shared/ui/lib/cloud/`. Connect web starts depending on `@libreloom/ui` (file:) and on `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@scure/bip39` 2.4.0.
4. **Zip is store-only, without ZIP64.** A folder over 4 GiB (or over 65,535 files) is refused, and the copy says so in plain words. The zip is built in browser memory as Blob parts.
5. **Share links.** 256-bit token in the URL fragment (`/share#<token>`), sent as the `X-Share-Token` header, stored as SHA-256. 7 days, revocable, last-opened time, at most 20 active per account. There is no label, because Connect must not store names. The Admin's unlocked browser names its own links.
6. **Connect filters what a link reaches.** It filters keys, recipients and snapshots by protection, and packs by pack scope tag. It cannot see inside packs. The link alone still opens nothing.
7. **Unbind starts a 30-day purge per Luna** (`luna_ids.purge_after`). The Luna's next storage call within 30 days cancels it. This replaces `backup_bindings`.
8. **Re-linking after DB loss.** The restore page calls the existing `PUT /api/v1/cloud/phrase` with the person's new user id, so their old phrase keeps working. Protections whose `created_by` is an old id are handed to the person restoring.
9. **Shared deps resolve from each app.** `resolve.dedupe` for the noble/scure packages in luna/web and Connect web vite configs, so the server build (`deploy/setup.sh` runs `npm install` only in `luna/connect/web`) needs no install in `shared/ui`. The deploy keeps working because it builds from the full repo checkout.
10. **No migrations.** The new column and table land only in the `CREATE TABLE` schema. A deployed Connect DB needs a reset or a manual `ALTER`.

Known limits to flag (not fixed in phase 3):
- `recover::index_tree_chunks` downloads every data pack once just to learn its size. A restore of a big backup downloads all of it. The restore runs on a blocking thread and holds the DB lock while it does.
- The new Connect browser has no in-page file preview (the old BackupBrowser had one); download only.
- The "Private items" row is not shown. Connect has no private data until phase 4.
- Share endpoints have no extra rate limit. The 256-bit token makes guessing hopeless.

## Shared contracts

### Record kinds on Connect (written by Luna, phase 2)
Every name is `[a-z0-9._-]`. A protection id is a lowercase UUID (36 chars, no dots).
- `snapshots/<snapshot_id 32 hex>`: JSON `SignedRecord`: `{"record":{"luna_id","protection_id","snapshot_id","created_at":int,"key_version":int,"tree_pack_id":hex64,"tree_hash":hex64,"meta":hex},"signature":hex128}`.
- `keys/<prot>.<version decimal>.<part>`: bytes = `sealed ‖ sig(64)`, where `part = hex(SHA-256(utf8(user_id))[0..16])` (32 hex chars).
- `recipients/<prot>.<version>`: JSON `{"users":["uid",...sorted],"signature":hex128}`.
- `self/<part>`: bytes = `encrypt(self_key, aad, signing_public)` (nonce 24 ‖ ct+tag), 32-byte plaintext.
- `users/list`: signed user list. Browsers do not use it.

### Crypto (all in `shared/ui/lib/cloud/backupCrypto.js`, mirrors `crypto.rs`)
- `canonical([[name, bytes], ...])`: for each name and value, u32 BE length then the bytes.
- Signature: Ed25519 over `"luna-sig-v1\0" ‖ domain ‖ 0x00 ‖ msg`. `verify(public, domain, msg, sig)`.
- `encrypt/decrypt(key, aad, data)`: XChaCha20-Poly1305, layout nonce(24) ‖ ct ‖ tag(16).
- `open(x25519Secret, aad, sealed)`: layout eph_pub(32) ‖ nonce(24) ‖ ct+tag.
- `derive(entropy16, lunaId)` → `{x25519Secret, x25519Public, selfKey, authSecret, authPublic}`.
- `chunkId(dedupKey, bytes)` = HMAC-SHA256. `packId(bytes)` = SHA-256.

Signed messages (domain → message):
- `snapshot` → canonical: `luna_id` utf8, `protection_id` utf8, `snapshot_id` utf8, `created_at` **i64 BE 8 bytes**, `key_version` **u32 BE 4 bytes**, `tree_pack_id` 32 raw bytes, `tree_hash` 32 raw bytes, `meta` raw bytes.
- `key-copy` → canonical: `aad` = key AAD, `sealed` = sealed bytes. Key AAD = canonical: `luna_id`, `protection_id`, `version` (**decimal text**, e.g. "2"), `user_id`.
- `recipients` → canonical: `luna_id`, `protection_id`, `version` (decimal text), `users` = `JSON.stringify(usersArray)` (compact, same as serde).
- Self-sealed AAD (not signed) = canonical: `luna_id`, `user_id`, `purpose`="signing-public".

AAD labels: pack key wrap `luna-pack-key-wrap-v1` (under the backup key), pack index `luna-pack-index-v1`, pack body `luna-pack-v1` (both under the pack key), tree `luna-tree-v1`, meta `luna-meta-v1` (both under the backup key).

Pack bytes: `0x01` ‖ u32 BE wrappedLen ‖ wrapped (`encrypt(backupKey, PACK_KEY_WRAP_AAD, packKey32)`) ‖ u32 BE indexLen ‖ sealedIndex ‖ sealedBody (the rest). Index plain: scope_id(32) ‖ u32 BE count ‖ count × (chunk_id 32 ‖ offset u64 BE ‖ len u32 BE). Body plain is the chunks laid end to end. Pack id = SHA-256(all pack bytes).
Tree: the tree pack holds one chunk whose id is `tree_hash = SHA-256(sealedTree)`. `sealedTree = encrypt(backupKey, "luna-tree-v1", json)`, and json is `{"entries":[{"path","size","mtime","chunks":[{"id":hex,"pack":hex,"offset","len"}]}]}`.
Meta JSON (after R1): `{"name","source_drive","source_path","started_by","started_by_name"}`.
Key copy plaintext: 64 bytes = backup key(32) ‖ dedup key(32).
Pack scope tag on Connect = `hex(chunkId(dedupKey, "luna-scope-v1")[0..16])` (32 hex). It is also the first 16 bytes of the pack index's scope_id.

### Fixture (R1) `luna/crates/lunad/src/backup/cloud/fixture.json`
See p3-R1.md for the exact shape. W1 tests open it.

### Connect HTTP (G3, G4)
Account routes use `acct.AccountAuth` + `acct.RequireVerifiedEmail` (the household `/login` session; NOT `/admin`). Errors are `{"error": "<sentence>"}` via `JSONError`.
- `GET /api/v1/cloud/lunas` → `{"lunas":[{"luna_id","name","linked":bool}]}`
- `GET /api/v1/cloud/lunas/{lunaID}/records/{kind}` (kind ∈ snapshots|keys|recipients|self) → `{"records":[{"name","data":"<std base64>"}]}` sorted by name
- `GET /api/v1/cloud/lunas/{lunaID}/packs/{id}` → raw bytes, `application/octet-stream`
- `POST /api/v1/cloud/share-links` `{"luna_id","scope_kind":"user"|"backup","scope_value"}` → `{"id","token","expires_at"}`
- `GET /api/v1/cloud/share-links` → `{"links":[{"id","luna_id","scope_kind","scope_value","created_at","expires_at","last_opened_at"}]}` (active only)
- `DELETE /api/v1/cloud/share-links/{id}` → `{"ok":true}`
Public, header `X-Share-Token`:
- `GET /api/v1/share` → `{"luna_id","luna_name","sent_by","scope":{"kind","value"},"expires_at"}` (also sets last_opened_at)
- `GET /api/v1/share/records/{kind}` → same shape as the account route, filtered
- `GET /api/v1/share/packs/{id}` → raw bytes, filtered
Scope for kind `user`: value = 32-hex part. Scope for kind `backup`: value = protection id.

### Luna HTTP (R2), Admin only
- `GET /api/v1/cloud/restore` → `{"needed":bool,"luna_id":string|null,"signing_public":b64|null,"cloud_snapshots":int,"indexed_snapshots":int}`
- `GET /api/v1/cloud/restore/records/{kind}` (kind ∈ self|recipients|keys) → `{"records":[{"name","data":b64}]}`
- `POST /api/v1/cloud/restore` `{"keys":[{"protection_id","version":int,"key":b64,"dedup_key":b64}],"old_user_ids":[string]}` → `{"snapshots","already_indexed","skipped"}`
- (existing) `PUT /api/v1/cloud/phrase` re-links the person afterwards.

## Opus reviewer checklist
- Byte formats: run the R1 fixture through W1 tests. Check that i64/u32 BE, the decimal-text version and the JSON.stringify of users match Rust. The fixture must be produced by Rust, not hand-written.
- Every signature is checked before decrypt or use: snapshot record, key copy, recipients. The signing key comes only from the self-sealed record opened with the phrase, never from `luna_ids.signing_public` or a Connect JSON field. On the Luna restore page it must also equal Luna's `signing_public`, or nothing is sent.
- Pack id is checked (SHA-256) and every chunk's HMAC is recomputed after decrypt. The tree hash is checked.
- A snapshot whose `luna_id` differs from the Luna being viewed is dropped.
- Share links: token in the fragment only, header on calls, hash stored, expiry and revocation checked on every call, `last_opened_at` updated, 404 with one sentence for unknown/expired/revoked (no oracle). Account routes check that the link's Luna belongs to the account. DELETE only hits the caller's own links. Rows are removed in PurgeStorage.
- Filtering: user scope only reaches protections where the part holds a copy at that protection's latest version. Packs only reach scopes of in-scope snapshots' tree packs.
- Teardown complete: `grep -rn "backup_objects\|backup_bindings\|BackupBrowser\|backupTree\|fetchBackupBlob\|/api/v1/backups" luna/connect` finds nothing outside dist/. Billing, quota, admin stats and B2 delete now use the storage tables. Egress is recorded on the new pack and record reads.
- Purge after unbind: scheduled on unbind, cancelled by the Luna's next authorized storage call, and executed by ProcessRetention. It never touches other Lunas on the account.
- `ensure_key` mints a new key version after recovery: recovered versions have no recipients meta (keys.rs `ensure_key`). So recovered keys are never used to write (plan §5 belt and braces).
- Restore endpoint: Admin only. Keys are validated as 32 bytes. Remapping `created_by` touches only ids that match no current user.
- Plain language: the phishing line is on every phrase prompt (unlock, share page, Luna restore: "Only type your recovery phrase on <host>"). There is no jargon (no "key version", "pack", "snapshot" in UI copy; say "version", "copy"). Errors name the failed action.
- Connect web: no `focus:ring` on inputs, sentence case, no `uppercase`, no `font-mono` with bold. Luna web: AGENTS.md design rules, `npm run scan:colors`.
- `npm test` passes in shared/ui, luna/web, luna/connect/web. `go test ./internal/...` in luna/connect passes. `cargo test -p lunad --lib backup::cloud api::cloud_restore` passes.
