# Recovery phrase card — plan for review (2026-10-20)

Planning only. Nothing here is built yet.

## 1. What's true today

- **The card exists, but almost nobody can reach it.** `RecoveryPhraseCard.jsx` is the last card inside `CloudBackupCategory`, which sits in **External services**. That category shows only to an Admin, and only while `{data_dir}/device-token` holds a correctly formatted token (`connect_active`). Members never see it. A Luna with no device token shows it to nobody. (Checked in a browser against a real `lunad` on 2026-10-20: the category is missing without a token and appears with one.)
- **External services was copied from Sol.** Cursor Agent built it in `5732977e` and `6391432c` (August 2026) to "match LibreServ". Nobody designed it for Luna.
- **The state gallery couldn't show it either.** `Gallery.jsx:157` appends `?__mock=` after the URL's `#`, so every scenario whose URL has a hash (42 of them) loads without its seed. Fix separately.
- **Copy points to a place that doesn't exist.** `private_run.rs` `NO_PHRASE` says "Set up your recovery phrase in Settings → Cloud backup". The gallery scenario `dashboard/no-phrase` checks for "Settings → Security / Devices", which is wrong too.
- **Cloud backup starts without a phrase.** `POST /api/v1/cloud/backups` and `ProtectSheet.jsx` never look at the phrase. The backup is created and then sits held: "Set up your recovery phrase…" for private items, "Waiting for an Admin…" for shared ones. The `dashboard/no-phrase` note says that state shouldn't be possible.
- **"Change" and "Get a new phrase" do the same thing.** Both call `openSetup(true)`. The check-first `{kind: "change"}` dialog is wired up but nothing opens it.
- **Replacing a phrase needs nothing but a live session.** `PUT /api/v1/cloud/phrase` asks for no old words and no password. Anyone at an unlocked browser can swap someone's phrase.
- **Replacing a phrase is expensive, and it happens automatically.** Two rules compare stored keys on every run:
  - `keys::ensure_key` compares the saved reader list (`cloud_recipients:<protection>:<version>` meta, public keys included) with today's. Any difference starts a new key version with a fresh dedup key (decision 2026-10-17), so every shared backup the person is on uploads again in full.
  - `private::ensure_scope` compares the active scope's `seal_public` with the owner's key. A difference retires the scope as `old_phrase` (removed after 30 days).
- **After a replacement, only the newest shared version is sealed to the new phrase** (`run.rs` `publish_and_copy` → `keys::publish_key`). The person loses their own access to older versions, though Admins and others on the backup keep theirs.
- **Luna keeps every shared key version.** `backup_keys` rows are never deleted (`db::list_backup_keys`), so Luna can re-seal older versions to someone's new key itself.
- **No last-Admin guard on replacement.** Protect plan §5 step 7 says replacing the last Admin's phrase is blocked. `users.rs` guards only demote and remove; `set_phrase` has no check. That's now the intended rule (§6, decision 1).
- **Already built, and the card can reuse it:** the 90-day `check_due`, old-phrase copies with their 30-day grace (`old_phrase_copies` on backup rows, `remove_old_copies` in `private_backups.rs`), the Member-before-Admin hold, and `RecoveryPhraseCheck` with `onVerified`.

## 2. Where it lives

Remove **External services** from Luna completely. Two categories replace it:

- **Cloud backup** (cloud icon). For every role, shown only while Connect is active. With Connect off there is no category and no card. Order:
  1. **Recovery phrase** (everyone)
  2. Cloud backup list (everyone; the API already limits it to what each person may see)
  3. Cloud restore / Private restore (these already hide themselves from non-Admins)
- **Luna Connect** (plug icon). Admins only, shown only while Connect is active. Holds today's `RemoteCategory` card (address, tunnel status, Open Luna Connect).

Why not Security: a phrase means nothing without Connect, and Security is always shown. The category name also makes the existing `NO_PHRASE` copy true.

Also update `luna/AGENTS.md` ("External Services UI shows only when `connect_active`") and the scenario URLs that use `#external_services`.

## 3. The card

Title `Recovery phrase`, `KeyRound` icon. InfoHint: "The 12 or 24 words that open your cloud backups. Luna never sees them."

| State | Surface | Actions |
|---|---|---|
| Loading | `Checking your recovery phrase…` | — |
| Load failed | `Could not load your recovery phrase. Try again later.` | — |
| **Not set** | Pill `Not set up` · "Cloud backups of your files can start once you set one up." | `Set up` (primary) |
| Set | Pill `Ready` · "Set up on October 3, 2026 · Last checked October 10" (or `· Not checked yet` while `last_checked_at` is 0) | `Check my phrase`, `Change phrase` |
| Set, check due | Pill `Check due` · same line as Set | `Check my phrase` becomes primary |
| Old-phrase copies waiting | Extra row: "Backups made with your old phrase · removed on November 19" | `Delete now` (confirm says what's lost) |
| Lost words | Collapsible row: `Lost your recovery phrase?` | `Get a new phrase` (accent, §4.3) |

- "Not set" copy for a Member while no Admin has a phrase adds one line: "Shared backups also wait for an Admin to set up theirs."
- Status additions to `GET /api/v1/cloud/phrase`: `last_checked_at`, `admin_has_phrase`, `old_phrase_copies {count, removed_at}` (move it here from the backup rows, or keep both).
- **Check my phrase** gets the first-class redesign asked for in `dashboard/check-overdue`: title `Check my phrase`, one word box per position (paste spreads across boxes, BIP39 autocomplete, a word turns invalid when it isn't on the list), a 12/24 switch, and a clear right/wrong outcome. The same component serves the first step of a change, and the dashboard reminder.

## 4. Three reasons to replace a phrase

People replace a phrase for three different reasons, and each needs different handling:

| | **New phrase** (have the words, they're safe) | **Leaked** (have the words, someone else may too) | **Lost** (don't have the words) |
|---|---|---|---|
| Entry | `Change phrase` → "I want a new phrase" | `Change phrase` → "Someone else may have seen it" | `Lost your recovery phrase?` → `Get a new phrase` |
| Proof | Old words | Old words | Luna password |
| Shared key versions you're on | All re-sealed to the new phrase | All re-sealed to the new phrase | All re-sealed to the new phrase |
| New shared data | Same key version | **New key version**, same dedup key | Same key version |
| Uploads again | Nothing | New and changed files go under the new key right away; old packs move to it in the background (§4.4) | Nothing |
| Private history | Kept (phase 5) | Kept (phase 5), with an optional `Delete older private versions` | **Lost.** Old copies stay 30 days in case the words turn up |
| New private data | Same scope (phase 5) | New scope | New scope |
| Old phrase's copies on Connect | Replaced | Replaced | Shared: replaced. Private: kept 30 days |
| Can't be undone | — | Anything already opened or downloaded with the old words | — |

**Why each row:**
- **Every shared version you're on is re-sealed, in all three cases.** Luna keeps every version in `backup_keys`, so it re-seals them itself. This gives nobody anything new: anyone holding the old words could already open those versions. So losing a phrase costs **private history only**, and the Lost confirm can say exactly that.
- **"Replaced", not "deleted":** a sealed key copy is stored as `keys/<backup>.<version>.<user>` (`keys::key_record_name`), with no phrase in the name. Re-sealing writes the same name, so the new copy replaces the old phrase's copy in one step. Private scope records work the same way (`pscopes/<scope>`). Nothing needs a separate delete.
- **Lost starts no new key version** (decided 2026-10-20). A lost phrase isn't a leaked one: if nobody else has the words, leaving things readable to them is safe. Lost is the plain change, minus the old words, plus the password, and private history can't follow.
- **Leaked starts a new key version but keeps the dedup key.** The new version key is what shuts out the old words: new packs and trees are sealed under it. The dedup key only names chunks, and chunk ids never appear in plain on Connect (pack indexes and trees are encrypted), so someone holding the old dedup key learns nothing from new uploads. Keeping it is what lets "unchanged files stay where they are" work with the run as it is (§4.4). A fresh dedup key would change every chunk id, so the next run would upload everything at once.
- **The 2026-10-17 fresh-dedup rule still applies when someone joins a backup.** That's the one case where a kept dedup key would let a newcomer open old versions.
- **The old words alone don't reach Connect.** Opening a backup there also takes the Admin's Connect sign-in or a share link. Worth one line in the Leaked copy.

### 4.1 Change phrase (I still have my words)

1. Enter the current words (the redesigned check, §3).
2. One question, two `CardButton`s: **"Why are you changing it?"**
   - `I want a new phrase`: "Your current words stop working. Nothing uploads again."
   - `Someone else may have seen it`: "Your old words stop working right away. Luna then moves your cloud backups to the new phrase in the background, which can take days. Until it finishes, someone who already used your old words could still open files that haven't changed."
3. Show and confirm the new words (today's `RecoveryPhraseSetup`).
4. Save (§4.5). Toast: `Recovery phrase changed.`
5. Leaked only (phase 5): an optional last step, `Delete older private versions` (§4.4).

### 4.2 Private items before phase 5

Until private scopes have their own key pair (§5), private history can't move to a new phrase:
- **New phrase:** private history retires with the 30-day grace, as today. The step-2 copy says: "Older versions of your private items stay with your old words for 30 days, then Luna removes them."
- **Leaked:** old private copies are removed **at once**, so the old words stop opening them. The step-2 copy adds: "Older versions of your private items can't be kept."

Once phase 5 lands, both lines go away.

### 4.3 Get a new phrase (lost words)

1. Collapsible row → `Get a new phrase` opens a ConfirmModal (`warning` haptic) that names what's lost:
   - "Private items backed up with your old phrase can't be opened. Luna keeps them for 30 days in case you find the words, then removes them."
   - "Your shared cloud backups stay open to you with the new phrase. Nothing uploads again."
2. Re-enter your Luna password, in a field in the same modal.
3. Show and confirm the new words.
4. Save (§4.5). Toast: `New recovery phrase saved.` The card then shows the old-phrase copies row.

### 4.4 Leaked: moving to the new key in the background

The leak closes over days instead of never, and no backup waits on it.

**Right away.** The save starts key version N+1 with the dedup key of version N. The next run works as it does today: every chunk is looked up in the backup's dedup scope (`run.rs` `CopyState::chunk` → `db::find_chunk`), which hasn't changed. Unchanged chunks stay in their version-N packs, and new and changed chunks go into new packs under N+1. The new snapshot is sealed under N+1 and points at packs from both versions.

**Readers open each pack with the version that sealed it.** Today every reader opens all of a snapshot's packs with that snapshot's key version: Connect's `readerFor` (`connect/web/src/lib/cloudDownload.js`) passes one key to `makePackReader`, and Luna's run, check and restore do the same. Change them to try each version key they hold, newest first, until the wrapped pack key opens. AEAD fails fast on a wrong key, and a backup has only a few versions.
- `shared/ui/lib/cloud/cloudFormat.js`: a `makePackReaderForVersions(getPack, keysByVersion)` built on the existing `makePackReaderWith`.
- Luna: the same in `format::open_pack`'s callers (the `unwrap_key` closure), fed by `db::list_backup_keys`.
- No format change: `PACK_VERSION` stays 1.
- Connect's unlock (`cloudUnlock.js`) already collects `keysByVersion` for every version the phrase opens. Share links with `requireLatest` keep working: the latest version's copy is there.

**In the background, on the idle trickle,** Luna moves every version-N pack that a retained snapshot still points at:
1. Download it (Luna holds no pack bytes locally) and open it with the version-N key.
2. Seal the same chunks into a new pack under N+1. The chunk ids stay the same; only the pack id changes.
3. Upload it, then point the local index (`find_chunk`) at the new pack.
4. Once every pack a retained snapshot points at has moved, rewrite that snapshot: a new tree with the new pack ids in `ChunkRef.pack`, sealed under N+1, and a new signed snapshot record (`key_version` = N+1, new `tree_pack_id` and `tree_hash`).
5. Mark the old packs and old tree packs for the normal mark-then-delete cleanup.

Order: packs the newest snapshot uses first, since current files matter most; then older retained copies.

**Costs, said out loud:**
- It downloads and uploads everything again, just slowly and without blocking anything.
- Until the old packs are deleted, Connect holds both: up to twice the backup's size, which counts against storage and the $8/TB bill. If storage fills, the move pauses and never deletes old copies to make room (Protect plan §5 "Space").

**Status:** the backup row and the card show `Moving to your new phrase · 40%` (bytes moved over bytes still under old versions). That's not a problem state, so no toast and nothing in Needs you.

**Locking:** a move step takes the same per-backup run lock as a run, one pack at a time, so runs and the move take turns. Snapshot rewrites commit in one SQLite transaction with their pack marks, like a run's commit.

**A second leak mid-move** starts N+2. The move then targets N+2, and packs already moved to N+1 move again.

**Private items (phase 5):** Luna can't open private packs, so it can't move them. Leaked starts a new private scope, and its first backup packs every file still on the drive again from the source files. Older versions and deleted files that exist only in the old scope stay there, now opened by the new phrase (§5) but also by anyone who already used the old words. So the Leaked flow ends with an optional step: `Delete older private versions`, which names what's lost (earlier versions and deleted files that exist only in the cloud). Skipping it keeps them, and the copy says the old words may still open them.

### 4.5 The save

One endpoint, `PUT /api/v1/cloud/phrase`:

| `mode` | Sent with | Allowed when |
|---|---|---|
| none | new keys | no phrase is set yet (first setup) |
| `change` | new keys, `old_signature` | a phrase is set |
| `leaked` | new keys, `old_signature` | a phrase is set |
| `lost` | new keys, `password` | a phrase is set |

Phase 5 adds `rescoped` to `change` and `leaked` (§5).

**Proof:**
- `change` and `leaked`: the browser calls `POST /api/v1/cloud/phrase/challenge`, then signs the challenge with the **old** auth key under a new domain, `phrase-replace`. The PUT takes the challenge (`take_challenge`, single use) and verifies against the stored `auth_public`. A separate domain means a phrase-check signature can never be replayed as a replacement.
- `lost`: `auth.verify_password_for_user` (`auth.rs`). A wrong password should count toward the same lockout as a wrong sign-in; check that it does.

**In one SQLite transaction:**
1. Save the new user keys (`set_user_keys`, as today: the new phrase shows "Not checked yet" until its first check).
2. For every shared version whose saved reader list (`cloud_recipients:<backup>:<version>` meta) includes this person: replace their `seal_public` in that meta. `ensure_key` then sees the same readers, so a `change` or `lost` starts no new version.
3. `leaked` only: start version N+1 for each of those backups, reusing version N's dedup key (a new `keys::start_version_keeping_dedup`).
4. Queue a re-seal job for this person.
5. Private, before phase 5: `change` and `lost` retire the active scope (30-day grace, as today). `leaked` retires it with no grace.

**After the transaction, in the background (the same pattern as today's `publish_users`):** the re-seal job writes a sealed, signed copy of every version key this person is on, plus the new user list. Each copy replaces the old phrase's copy under the same name. The job is retried on every run until it finishes. Until then, `GET /api/v1/cloud/phrase` reports `resealing: true`, and the card says "Updating your cloud backups to the new phrase…".

**Check before building:** whether Connect's store keeps old object versions when a record is overwritten (B2 buckets keep every version by default). If it does, "replaced" isn't true until those versions are purged, and the store must delete prior versions on overwrite for `keys/` and `pscopes/`.

## 5. Phase 5: one key pair per private scope

**Why a format change.** Each private pack carries its own key, sealed to the owner's public key, **inside the pack header** (`format.rs` `finish`), and the pack id is the SHA-256 of the whole pack. Trees, metadata and the scope's dedup key are sealed straight to the owner too (`private.rs` `seal_tree`, `seal_meta`, `seal_dedup`). Re-sealing any of them would change the pack, so keeping history across a new phrase would mean uploading everything again.

**The change:**
- When Luna makes a private scope, it also makes a random X25519 + ML-KEM key pair for it. It seals the secret half to the owner's public key, keeps only the public half and the sealed secret, and wipes the secret from memory. Luna already holds the scope's dedup key, so this matches what it holds today. What it never keeps is anything that opens a private pack.
- Pack keys, trees, metadata and the dedup key are sealed to the **scope** public key instead of the owner's. Same purposes and `aad` as today.
- `ScopeRecord` (`pscopes/<scope>`, signed by Luna) gains `scope_public` and `sealed_scope_secret` (purpose `luna-private-scope-secret-v1`, same `aad` binding). `seal_public` and `auth_public` stay the owner's, for checking who may open the scope on Connect.
- DB: `private_scopes` gains `scope_public` and `sealed_scope_secret`. `ensure_scope` stops comparing `seal_public` with the owner's key: a scope retires only when a save says so, never because keys differ.
- Early development, no migrations: switch the format and drop today's direct-to-owner sealing.

**During a change or leak:** after step 3 of §4.1, the browser holds both the old and the new keys. It:
1. fetches the person's scopes from a new `GET /api/v1/cloud/phrase/scopes` (scope id plus `sealed_scope_secret`);
2. opens each secret with the old words' key and seals it to the new public key;
3. sends them in the PUT as `rescoped: [{ scope, sealed_scope_secret }]`.

Luna stores them in the same transaction and republishes each `pscopes/<scope>` record with the new owner keys, replacing the old one. A scope the browser couldn't re-seal (missing or damaged record) retires with the 30-day grace, as today, and the toast says how many.

**Leaked** then also starts a new scope for new data (new key pair and new dedup key); the old one stays as history. `Delete older private versions` retires the old scope with no grace.

**Readers:** Connect's unlock (`privateUnlock.js`) and `shared/ui/lib/cloud/cloudPrivate.js` (`privateUnwrap`) gain one step: open `sealed_scope_secret` with the phrase's key, then use the scope secret wherever they use the owner secret today. Restore after database loss (`private_recover.rs`) gets the same step.

**Test vectors:** extend the shared crypto vectors (`crates/lunad/src/backup/cloud/crypto.rs`, `shared/ui/lib/cloud/backupCrypto.test.js`) with one scope key pair, a sealed scope secret, and a pack key sealed to it, so Rust and the browser agree byte for byte.

## 6. Decisions

All decided 2026-10-20:

1. **Last Admin with a phrase loses their words:** allowed, with no extra warning. With §4's re-sealing nothing shared is lost. The block stays only on demoting or removing that Admin.
2. **Change needs no password:** proving the old words is enough. Lost still asks for the Luna password.
3. **"Delete now" for old-phrase copies:** on both the card and the shield sheet.
4. **Lost** starts no new key version: Luna re-seals every version to the new phrase, and nothing uploads again.
5. **Leaked** starts a new key version and moves old packs to it in the background (§4.4). Private versions only in the cloud, which Luna can't move, get an optional `Delete older private versions` step; if the owner skips it, they stay and the copy says so.

### Still open

1. **Leaked keeps the dedup key.** Earlier I proposed a fresh dedup key for Leaked. The run can't do "unchanged files stay where they are" with a fresh one: every chunk id changes, so everything uploads at once. Keeping it is safe for the reasons in §4. Needs your OK.
2. **Lost, but maybe found.** Someone who lost their words and fears they were found can't choose Leaked, since it asks for the old words. Proposal: the Lost confirm asks "Could someone else have found them?", and Yes gets Leaked's treatment (new version, background move, old private copies removed at once instead of after 30 days).

## 7. Around the card

- **Phrase before the first cloud backup.** In `ProtectSheet`, "Back up to the cloud" with no phrase opens `RecoveryPhraseSetup` inline and creates the backup after the phrase is saved. Server side, `POST /api/v1/cloud/backups` refuses with 409 `needs_phrase` when the caller has none, so the held-without-phrase state can't be created. Shared backups started by a Member while no Admin has a phrase still wait, with today's copy.
- **Dashboard.** With the gate in place, `dashboard/no-phrase` can't happen for new backups. Drop the scenario. The `check-phrase` intent opens the redesigned check.
- **Copy fixes.** `NO_PHRASE` stays "Settings → Cloud backup", which becomes true. Rename `Check my words` to `Check my phrase` everywhere.
- **Last-Admin guard.** No change: replacing a phrase stays allowed, and `users.rs` keeps blocking demote and remove (§6, decision 1).

## 7a. Before implementation

- **Done 2026-10-20:** `docs/protect-rebuild/plan.md` points here, and the gallery `#` URL bug is fixed.
- **Linking a Luna to Connect lives in About → Advanced** (`UpdateSourceCard` → `ConnectDeviceCodeForm`). The new Luna Connect category shows only once a token exists, so linking stays there. Decide whether that's fine, or whether Luna Connect should always show to Admins with a "Link this Luna" state. Doesn't block phase 1.
- **Check before phase 3:** whether overwriting a record on Connect leaves old versions behind (§4.5).

## 8. Phases

Each phase ships on its own and leaves Luna working.

1. **Placement and card states:** remove External services, add the Cloud backup and Luna Connect categories, the status fields, the card table in §3, the copy fixes. Web, plus a small status change in `cloud_phrase.rs`.
2. **Gate:** phrase before the first cloud backup (ProtectSheet inline setup, plus the 409 on create).
3. **The three cases:** the save in §4.5 (modes, proof, the transaction, the re-seal job), the two-button question, the Lost confirm, the check redesign, and readers that open each pack with the version that sealed it (§4.4). Private items follow §4.2. Leaked starts its new version here, but old packs stay under the old key until phase 4, so the Leaked copy in this phase says: "Files you change from now on are locked to the new phrase. Older copies stay locked to the old one."
4. **Leaked background move** for shared backups (§4.4): the pack move on the idle trickle, snapshot rewrites, the `Moving to your new phrase` status, the pause when storage fills. The Leaked copy switches to the §4.1 wording.
5. **Private history:** the per-scope key pair (§5), the browser re-seal in the change flow, the Connect and restore readers, the test vectors, `Delete older private versions`. The §4.2 lines go away.

## 9. Gallery scenarios to add

Fix the gallery's `#` URL bug (§1) first, or none of these load their seed.

- `settings/phrase-member-not-set`: a Member, Connect on, no phrase. The card shows; with no Admin phrase it adds the shared-backups line.
- `settings/connect-off`: neither Cloud backup nor Luna Connect in the sidebar.
- `settings/phrase-set-check-due`: pill `Check due`, check is the primary action.
- `settings/phrase-change`: old words, then "I want a new phrase", then new words. Wrong old words are refused.
- `settings/phrase-leaked`: old words, then "Someone else may have seen it". The copy says what can't be taken back.
- `settings/phrase-leaked-moving`: a backup row and the card show `Moving to your new phrase · 40%`, with no problem state.
- `settings/phrase-leaked-moving-full`: Connect storage fills mid-move. The move pauses and says what to do; nothing old is deleted.
- `settings/phrase-lost`: the confirm names what's lost, needs the password, then shows the old-phrase copies row.
- `settings/phrase-resealing`: right after a save, the card says "Updating your cloud backups to the new phrase…" until the re-seal job finishes.
- `files/cloud-backup-no-phrase`: "Back up to the cloud" opens setup first.
- Drop `dashboard/no-phrase` (§7).
