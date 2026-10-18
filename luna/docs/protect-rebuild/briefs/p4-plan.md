# Phase 4 plan: private item backups

Plan: `/var/home/plainskill/.claude/plans/protect-rebuild.md` §2 (who can do what), §3 (scope), §5 Keys / Private items / Lost phrase / Cleanup / Checks / Luna loses its database / What Connect sees, §6, §7.
Every implementer reads `brief-common.md`. Web tasks also read `brief-web.md` and `AGENTS.md` (Plain language, Frontend, Design).

**Start rule:** phase 4 starts only after every phase 3 review fix is committed (they touch `recover.rs`, `api/cloud_restore.rs`, Connect `cloud_read.go`, `share_links.go`, `storage.go`, `schema.go`, Connect web cloud files). Check `git status` is clean in those paths first.

## What already exists (do not re-plan; one regression assertion each, as noted)
- Walker skips private items below the root (`backup/scope.rs` test `private_item_folder_is_skipped_with_contents`). Albums export drops them (`albums_export.rs` `private_item_is_dropped`). Shared backups therefore never contain private data: T6 adds one assertion that a shared drive backup of a folder holding a private item has no `.luna-` entry in its copy.
- `protections.private_owner`, `NewProtection.private_owner`, manifest `private_owner`, `AccessList.admins`, `deleted_users`, phrase check, "Get a new phrase" for shared backups.
- Dashboard `BackupsCard` / `AllBackupsModal` (drive rows only) and `backup_checks` (drive rows only): phase 5.

## Waves

| Wave | Tasks (parallel inside a wave) | Needs |
|---|---|---|
| 0 | **T1** `db.rs` private tables + helpers; empty module stubs; `for_row` stub and switch of every row-based `for_source` call | phase 3 fixes committed |
| 1 | **T2** `access_list.rs`: real `for_row`, `for_private`, `private_source`. **T3** `cloud/private.rs` crypto + records, `format.rs` domain sign/verify. **T4** `cloud/run.rs` refactor behind a `Sealer` (no behaviour change) + root path fix. **T5** Connect Go: private challenge/session handler + tables | T1 |
| 2 | **T6** drive side: `drive_backup.rs`, `drive_backup/ops.rs`. **T7** `cloud/private_run.rs` + `cloud/private_check.rs`. **T8** fixture: private section in `fixture.rs` / `fixture.json`. **T9** `api/backup_folder.rs` private restore | T2 (T6, T9), T3+T4 (T7), T3 (T8) |
| 3 | **T10** `cloud/ops.rs` + `cloud/retention.rs`: create/run/check/delete/sweep dispatch, old-phrase retire. **T11** `api/private_backups.rs` + private fields in `api/backups.rs` / `api/cloud_backups.rs`. **T12** `cloud/private_recover.rs` + `api/cloud_restore_private.rs` + `recover.rs` skip. **T13** shared JS: private open/verify in `cloudFormat.js` / `cloudKeys.js`. **T14** Connect Go: read gate + share variants + routes | T6+T7 (T10), T2+T6 (T11), T3+T8 (T12, T13), T5+T8 (T14) |
| 4 | **T15** Luna web: ProtectSheet private branch. **T16** Luna web: private restore card. **T17** Connect web data layer: private sessions, unlock, downloads | T10+T11 (T15), T12+T13 (T16), T13+T14 (T17) |
| 5 | **T18** Connect web UI: "Private items" row in each user group | T17 |

18 tasks in 6 waves. Each is small enough for a Haiku context; the private run, Connect gate and Connect web were split so no task holds two large files.

### File ownership (exclusive; one owner per wave; order when a file has several owners)
- `db.rs`: T1 only. Nobody else edits it; a task that needs another helper reports it and the orchestrator decides.
- `api/mod.rs`, `backup/cloud/mod.rs`: T1 only (it adds every new module up front as a stub).
- `backup/access_list.rs`: T1 (stub `for_row`) → T2.
- `backup/drive_backup.rs`, `backup/drive_backup/ops.rs`: T1 (call switch) → T6.
- `backup/cloud/ops.rs`: T1 (call switch) → T10. `backup/cloud/run.rs`: T1 (call switch) → T4.
- `backup/cloud/format.rs`: T3 only. `backup/cloud/private.rs`: T1 (stub) → T3.
- `backup/cloud/private_run.rs`, `private_check.rs`: T1 (stub) → T7. `private_recover.rs`: T1 (stub) → T12.
- `backup/cloud/retention.rs`: T10. `backup/cloud/check.rs`: nobody (T10 dispatches before calling it). `backup/cloud/recover.rs`: T12 (one guard only).
- `backup/cloud/fixture.rs`, `fixture.json`: T8 only.
- `api/backup_folder.rs`: T9. `api/backups.rs`, `api/cloud_backups.rs`, `api/private_backups.rs`: T1 (stub for the new one) → T11. `api/cloud_restore_private.rs`: T1 (stub) → T12.
- Connect: `database/schema.go`: T5 only. New `handlers/private_open.go`: T5. `private_open_test.go`: T5 → T14 (adds one fixture test). `handlers/cloud_read.go`, `handlers/share_links.go`, `api/server.go`: T14.
- `shared/ui/lib/cloud/cloudFormat.js`, `cloudKeys.js`, new `cloudPrivate.js`: T13.
- Luna web: `components/files/ProtectSheet.jsx` (+ test): T15. New `lib/privateRestore.js`, `components/cloud/PrivateRestoreCard.jsx`, `components/settings/categories/CloudBackupCategory.jsx`: T16.
- Connect web: `lib/cloudUnlock.js`, `lib/cloudDownload.js`, `lib/cloudSource.js`, new `lib/privateUnlock.js` (+ tests): T17. `components/cloud/CloudBrowser.jsx`, new `components/cloud/PrivateItemsRow.jsx`, `pages/BackupsPage.jsx`, `pages/SharePage.jsx` (one prop each) (+ tests): T18.

Never touched in phase 4: `api/cloud_restore.rs`, `backup/cloud/keys.rs`, `backup/cloud/store.rs`, `api/cloud_phrase.rs`, Connect web `UnlockCard.jsx`, `ShareLink*.jsx`.

## Decisions taken in this plan (tell the user)
1. **Connect links a private scope to a user id and auth key.** The signed `pscopes/<scope>` record holds the owner's user id and auth public key in plain. Connect needs it to group the "Private items" row and to check the private-open signature, and it already sees user ids and auth keys in `users/list`. Connect still never sees names, sizes per person through the Admin API, folder layout or contents. Its operator could add up pack sizes per scope.
2. **One protection row per private item and destination, never a second row for a lost phrase.** A lost phrase is noticed on the next run: the owner's key no longer matches the scope's, so the old scope becomes "Sealed with your old phrase" (removed 30 days later) and a fresh scope starts. Same protection id, new scope.
3. **Only private folders get a shield.** Backups are folder-only already; a private file gets none.
4. **An Admin removes a deleted owner's private backups all at once** (`DELETE /api/v1/private-backups/owners/{owner}`), never one by one, and never opens them.
5. **After database loss, the recovered private index is read-only.** The owner rebuilds it in the browser; Luna marks that scope `recovered` and the next private run starts a fresh scope, so it uploads everything again (plan §5 belt and braces).
6. **No repacking of private packs.** Old ones age out whole.
7. **Connect shows no status for private items** (no names, no health). Status lives on Luna. Someone whose only backups are private shows on Connect as a group named "Another person on this Luna" (Connect can't read their name).
8. **A private session on Connect lasts 30 minutes** and opens one scope; the browser asks again with the phrase-derived auth key after that.

## Known limits (not fixed in phase 4)
- `private::adopt_ownerless` does not move `protections.private_owner`; an adopted item's old backups stay with the deleted owner until an Admin removes them.
- A private item shared with others: they get its drive backup (saved access list) but never its cloud copy; their shield says "Only <owner> can back up this item."
- Rebuilding a private index downloads every tree pack of that scope in the owner's browser.

## Shared contracts

### Local DB (T1)
```sql
CREATE TABLE IF NOT EXISTS cloud_private_scopes (
  scope TEXT PRIMARY KEY,            -- hex(chunk_id(dedup_key, "luna-scope-v1")[..16]), 32 hex chars
  owner TEXT NOT NULL,               -- user id
  x25519_public BLOB NOT NULL,       -- owner key the scope is sealed to
  dedup_key BLOB NOT NULL,           -- 32 random bytes, Luna holds it
  state TEXT NOT NULL DEFAULT 'active',   -- active | old_phrase | recovered
  retire_after INTEGER NOT NULL DEFAULT 0, -- unix secs; 0 = never
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cloud_private_scopes_owner ON cloud_private_scopes(owner);
CREATE TABLE IF NOT EXISTS cloud_private_trees (
  snapshot_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  tree BLOB NOT NULL                 -- plain Tree JSON (serde_json of format::Tree)
);
```
`cloud_snapshots.key_version` is 0 for private snapshots. Private snapshots, chunks, packs and runs use the existing `cloud_*` tables with the private scope string.

Rust (all in `db.rs`):
```rust
#[derive(Debug, Clone, PartialEq)]
pub struct PrivateScope { pub scope: String, pub owner: String, pub x25519_public: Vec<u8>, pub dedup_key: Vec<u8>, pub state: String, pub retire_after: i64, pub created_at: i64 }
pub fn insert_private_scope(conn: &Connection, s: &PrivateScope) -> anyhow::Result<()>;
pub fn get_private_scope(conn: &Connection, scope: &str) -> anyhow::Result<Option<PrivateScope>>;
pub fn active_private_scope(conn: &Connection, owner: &str) -> anyhow::Result<Option<PrivateScope>>; // state = 'active', newest created_at
pub fn list_private_scopes(conn: &Connection, owner: Option<&str>) -> anyhow::Result<Vec<PrivateScope>>; // ORDER BY created_at
pub fn set_private_scope_state(conn: &Connection, scope: &str, state: &str, retire_after: i64) -> anyhow::Result<()>;
pub fn delete_private_scope(conn: &Connection, scope: &str) -> anyhow::Result<()>; // also deletes its cloud_private_trees rows
pub fn get_private_tree(conn: &Connection, snapshot_id: &str) -> anyhow::Result<Option<Vec<u8>>>;
pub fn private_snapshot_ids(conn: &Connection, scope: &str) -> anyhow::Result<Vec<String>>; // from cloud_private_trees
pub fn private_scope_of_snapshot(conn: &Connection, snapshot_id: &str) -> anyhow::Result<Option<String>>;
pub fn commit_private_snapshot_tx(conn: &mut Connection, snap: &SnapshotInsert, pack_ids: &[String], scope: &str, tree_json: &[u8]) -> anyhow::Result<()>;
// = commit_snapshot_tx body + INSERT INTO cloud_private_trees, one transaction.
```
`delete_cloud_snapshot` also deletes the snapshot's `cloud_private_trees` row.

### Crypto and records (T3, `backup/cloud/private.rs`)
```rust
pub const PSCOPES_KIND: &str = "pscopes";
pub const PSNAPSHOTS_KIND: &str = "psnapshots";
pub const SCOPE_RECORD_DOMAIN: &str = "private-scope";
pub const PRIVATE_SNAPSHOT_DOMAIN: &str = "private-snapshot";
pub const PRIVATE_OPEN_DOMAIN: &str = "private-open";      // auth-key signature on Connect
pub const OLD_PHRASE_GRACE: i64 = 30 * 24 * 60 * 60;
pub const PACK_KEY_PURPOSE: &str = "luna-private-pack-key-v1";
pub const TREE_PURPOSE: &str = "luna-private-tree-v1";
pub const META_PURPOSE: &str = "luna-private-meta-v1";
pub const DEDUP_PURPOSE: &str = "luna-private-dedup-v1";
```
- `aad(purpose, luna_id, scope) = canonical([("purpose", purpose), ("luna_id", luna_id), ("scope", scope)])` (all utf8).
- Pack key wrap: `seal(owner_pub, aad(PACK_KEY, …), pack_key32)`. Tree: `seal(owner_pub, aad(TREE, …), serde_json(Tree))`; it is the tree pack's single chunk, chunk id = `tree_hash = sha256(sealed_tree)`. Meta: `seal(owner_pub, aad(META, …), serde_json(BackupMeta))`. Dedup copy: `seal(owner_pub, aad(DEDUP, …), dedup32)`.
- Scope: `scope_id = chunk_id(dedup, b"luna-scope-v1")`, `scope = hex(scope_id[..16])`. Pack index plaintext starts with `scope_id` (as shared). Packs upload with `X-Luna-Scope: <scope>`.
- Record names: `pscopes/<scope>`, `psnapshots/<scope>.<snapshot_id>` (65 chars).

`pscopes/<scope>` bytes = JSON:
```json
{"record":{"luna_id":"…","scope":"<32 hex>","user_id":"…","x25519_public":"<64 hex>","auth_public":"<64 hex>","created_at":1760000000,"sealed_dedup":"<hex>"},"signature":"<128 hex>"}
```
Signed by Luna's signing key, domain `private-scope`, message = canonical of: `luna_id` utf8, `scope` utf8, `user_id` utf8, `x25519_public` 32 raw, `auth_public` 32 raw, `created_at` i64 BE 8 bytes, `sealed_dedup` raw.

`psnapshots/<scope>.<id>` bytes = the same `SignedRecord` JSON as `snapshots/<id>` (`format.rs`), with `key_version` 0, `meta` = sealed meta, and the signature over the same `signed_bytes()` but domain `private-snapshot`.

Auth-key signature for Connect's private open: `Ed25519(auth_secret, "luna-sig-v1\0" ‖ "private-open" ‖ 0x00 ‖ canonical([("luna_id", utf8), ("scope", utf8), ("challenge", 32 raw)]))`.

### Connect private session (T5 handler, T14 routes and gate)
- `POST /api/v1/cloud/lunas/{lunaID}/private/challenge` (account auth) → `{"challenge":"<64 hex>"}`; 5 min, single use, stored as SHA-256.
- `POST /api/v1/cloud/lunas/{lunaID}/private/open` body `{"scope","challenge","signature"}` (hex) → `{"token":"<64 hex>","expires_at":int}`; 30 min.
- Share variants: `POST /api/v1/share/private/challenge`, `POST /api/v1/share/private/open` (share token header as phase 3). A user link opens only scopes whose `pscopes` record `user_id` has `part(user_id) == scope_value`; a backup link never opens one.
- Reads: `pscopes` is readable by account and by user links (user links see only their user's). `psnapshots` and any pack whose `storage_packs.scope` is a private scope need header `X-Private-Token` for that scope; `psnapshots` listing returns only names starting `<scope>.`.
- Refusal copy: 403 `"Enter your recovery phrase again to open your private items."`.

### Luna API (T11, T12)
- `GET /api/v1/private-backups/item?drive=&path=` → `{"private":bool,"inside_private":bool,"mine":bool,"owner_name":"…"}`. `owner_name` is "" unless `private` and the caller may see the item.
- `GET /api/v1/private-backups/mine` → `{"items":[{"drive_id","path","name","drive_backups":int,"cloud_backup":bool}]}` (the caller's own private folders on mounted drives).
- `GET /api/v1/private-backups/summary` → `{"owners":[{"owner_id","name","deleted":bool,"backups":int,"needs_look":int}]}`. Admin gets every owner; a Member gets only themselves.
- `DELETE /api/v1/private-backups/owners/{owner}` (Admin; owner must be deleted) → `{"removed":int}`.
- `DELETE /api/v1/private-backups/old-copies` (caller's own `old_phrase` scopes) → `{"ok":true}`; sets `retire_after = now`, the sweep removes them.
- Backup JSON (both `/api/v1/backups` and `/api/v1/cloud/backups`) gains `"private": bool`; cloud private rows also `"old_phrase_copies": {"count":int,"removed_at":int} | null`.
- `can_delete` for a private row: the owner, or an Admin when the owner is deleted.
- Private restore after DB loss (owner, signed in):
  - `GET /api/v1/cloud/restore-private` → `{"needed":bool,"luna_id":"…","signing_public":"<base64>","scopes":int}`. `needed` = the caller has a phrase and Connect holds a `pscopes` record for their key whose scope Luna has no `cloud_private_scopes` row for. No Connect, or no phrase → `needed:false`.
  - `GET /api/v1/cloud/restore-private/records/{kind}` (`kind` ∈ `pscopes`, `psnapshots`) → the same JSON shape as phase 3 `GET /api/v1/cloud/restore/records/{kind}` (`records_with_store` in `api/cloud_restore.rs`: sorted, `data` base64). Only the caller's: `pscopes` whose `x25519_public` equals the caller's `user_keys.x25519_public`, and `psnapshots` named `<one of those scopes>.…`. Luna reads Connect with its device auth.
  - `GET /api/v1/cloud/restore-private/packs/{id}` → raw pack bytes, only for a `tree_pack_id` named in one of the caller's `psnapshots` records (the browser needs tree packs only; data packs are never read during a rebuild). Anything else → 404.
  - `POST /api/v1/cloud/restore-private` body `{"scope","dedup_key":"<base64 32>","snapshots":[{"snapshot_id","record":"<base64 psnapshot bytes>","protection_id","meta":{"name","source_drive","source_path"},"tree":{"entries":[…Tree entries…]}}]}` → `{"restored":int}`.

### Copy rules for every UI task
- Sentence case. Names, paths, drives and URLs in copy wear `InlinePill`.
- Never say "scope", "pack", "snapshot", "dedup" or "seal" in UI. Say "backup", "version", "cloud copy", "private items".
- Phrase prompts carry: "Only type your recovery phrase on this Luna or on <InlinePill>connect.luna.libreloom.org</InlinePill>."
- Errors name what failed ("Could not rebuild your private backups list. …").

## Reviewer checklist (Opus, after wave 5)
1. `grep -rn "for_source(" luna/crates/lunad/src` → only `access_list.rs` internals, its tests, the two create paths. Every row-based caller uses `for_row`.
2. A private row's `access_json` has `"admins":false` after create, after a run, and after `on_grants_changed` (tests in T2/T6/T10).
3. `inside_private` is never used to refuse or stop a private item's own backup; `private_source` decides (T6 tests: owner creates, other user refused, folder inside refused, repath of the item itself keeps it active).
4. Cloud private path never calls `keys::ensure_key`, `publish_key` or `NO_ADMIN_PHRASE`; never writes `snapshots/` or `keys/` for a private row (T7 test with MemoryStore lists records).
5. Nothing in a private run decrypts with the owner's secret; Luna holds no owner secret. `source_looks_missing` and `check` for private rows use the local plain tree only.
6. Fixture: Rust `fixture_opens`, JS `shared/ui/lib/cloud` tests and the Go test all verify the same private signatures.
7. Connect: no route returns private-scope packs or `psnapshots` without a valid `X-Private-Token`, including the account `GetPack` with Kind `""`. Grep `writePack(` callers.
8. Retention and delete call `private::snapshot_record_ref`, never a literal `"snapshots"` for a private row.
9. Lost phrase: test where `user_keys.x25519_public` changes → old scope `old_phrase`, `retire_after = now + 30d`, new scope active, same protection id; sweep after 30 days deletes old psnapshots, pscopes record, trees, and marks old packs.
10. Recovered index: `recover.rs` never deletes packs whose scope has a `pscopes` record.
11. Copy: no "scope/pack/snapshot" in UI strings (`grep -rn "scope\|pack" luna/web/src/components --include=*.jsx | grep -v test` on new files); `npm run scan:colors` clean.
12. `cargo clippy -p lunad`, `go vet`, all vitest suites pass.
