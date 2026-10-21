# Recovery phrase card — plan for review (2026-10-20)

Planning only. Nothing here is built yet.

## 1. What's true today

- **The card exists, but almost nobody can reach it.** `RecoveryPhraseCard.jsx` is the last card inside `CloudBackupCategory`, which sits in **External services**. That category shows only to an Admin, and only while `{data_dir}/device-token` holds a correctly formatted token (`connect_active`). Members never see it. A Luna with no device token shows it to nobody. (Checked in a browser against a real `lunad` on 2026-10-20: the category is missing without a token and appears with one.)
- **External services was copied from Sol.** Cursor Agent built it in `5732977e` and `6391432c` (August 2026) to "match LibreServ". Nobody designed it for Luna.
- **The state gallery couldn't show it either.** `Gallery.jsx:157` appends `?__mock=` after the URL's `#`, so every scenario whose URL has a hash (42 of them) loads without its seed. Fix separately.
- **Copy points to a place that doesn't exist.** `private_run.rs` `NO_PHRASE` says "Set up your recovery phrase in Settings → Cloud backup". The gallery scenario `dashboard/no-phrase` checks for "Settings → Security / Devices", which is wrong too.
- **Cloud backup starts without a phrase.** `POST /api/v1/cloud/backups` and `ProtectSheet.jsx` never look at the phrase. The backup is created and then sits held: "Set up your recovery phrase…" for private items, "Waiting for an Admin…" for shared ones. The `dashboard/no-phrase` note says that state shouldn't be possible.
- **"Change" and "Get a new phrase" do the same thing.** Both call `openSetup(true)`. The check-first `{kind: "change"}` dialog is wired up but nothing opens it.
- **Replacing a phrase needs nothing but a live session.** `PUT /api/v1/cloud/phrase` asks for neither the old phrase nor a password. Anyone at an unlocked browser can swap someone's phrase.
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
| Lost phrase | Collapsible row: `Lost your recovery phrase?` | `Get a new phrase` (accent, §4.3) |

- "Not set" copy for a Member while no Admin has a phrase adds one line: "Shared backups also wait for an Admin to set up theirs."
- Status additions to `GET /api/v1/cloud/phrase`: `last_checked_at`, `admin_has_phrase`, `old_phrase_copies {count, removed_at}` (move it here from the backup rows, or keep both).
- **Check my phrase** gets the first-class redesign asked for in `dashboard/check-overdue`: title `Check my phrase`, one word box per position (paste spreads across boxes, BIP39 autocomplete, a word turns invalid when it isn't on the list), a 12/24 switch, and a clear right/wrong outcome. The same component serves the first step of a change, and the dashboard reminder.

## 4. Replacing a phrase: two questions

Two things decide how a replacement is handled, and they're independent:
- **Do you still have your phrase?** This only decides how you prove it's you: the old phrase, or your Luna password.
- **Could someone else have your phrase?** This decides what Luna does with your cloud backups. It's asked in both flows, so someone who lost their phrase but fears it was found gets the same protection as someone whose phrase leaked (decided 2026-10-20: a wording question, not a separate path).

| | **Someone else can't have it** | **Someone else may have it** |
|---|---|---|
| **You have it** (proof: old phrase) | New phrase | Exposed, phrase in hand |
| **You lost it** (proof: Luna password) | Lost | Exposed, phrase lost |

What each answer does:

| | **Can't have it** | **May have it** ("exposed") |
|---|---|---|
| Shared key versions you're on | All re-sealed to the new phrase | All re-sealed to the new phrase |
| New shared data | Same key version | **New key version**, same dedup key |
| Uploads again | Nothing | New and changed files go under the new key right away; old packs move to it in the background (§4.4) |
| Old phrase's copies on Connect | Replaced | Replaced |
| Can't be undone | — | Anything already opened or downloaded with the old phrase |

And for private items, which depend on both answers:

| | **Can't have it** | **May have it** |
|---|---|---|
| **You have it** | History kept (phase 5); same scope | History kept (phase 5), with an optional `Delete older private versions`; new scope for new data |
| **You lost it** | **History lost.** Old copies stay 30 days in case the phrase turns up; new scope | **History lost.** Old copies removed at once, since keeping them only helps whoever found it; new scope |

**Why each row:**
- **Every shared version you're on is re-sealed, in every case.** Luna keeps every version in `backup_keys`, so it re-seals them itself. This gives nobody anything new: anyone holding the old phrase could already open those versions. So losing a phrase costs **private history only**, and the confirm can say exactly that.
- **"Replaced", not "deleted":** a sealed key copy is stored as `keys/<backup>.<version>.<user>` (`keys::key_record_name`), with no phrase in the name. Re-sealing writes the same name, so the new copy replaces the old phrase's copy in one step. Private scope records work the same way (`pscopes/<scope>`). Nothing needs a separate delete.
- **"Can't have it" starts no new key version** (decided 2026-10-20). If nobody else has the old phrase, leaving things readable to it is safe.
- **"May have it" starts a new key version but keeps the dedup key** (decided 2026-10-20). The new version key is what shuts out the old phrase: new packs and trees are sealed under it. The dedup key only names chunks, and chunk ids never appear in plain on Connect (pack indexes and trees are encrypted), so someone holding the old dedup key learns nothing from new uploads. Keeping it is what lets "unchanged files stay where they are" work with the run as it is (§4.4). The price is the reader change in §4.4.
- **The 2026-10-17 fresh-dedup rule still applies when someone joins a backup.** That's the one case where a kept dedup key would let a newcomer open old versions.
- **The old phrase alone doesn't reach Connect.** Opening a backup there also takes the Admin's Connect sign-in or a share link. Worth one line in the "may have it" copy.

### 4.1 The question, worded once

Both flows ask it the same way, as two `CardButton`s: **"Could someone else have your phrase?"**
- `No, it's only mine` (or, in the lost flow, `No, it's just lost`): "Nothing uploads again."
- `Someone may have it`: "Your old phrase stops working right away. Luna then moves your cloud backups to the new phrase in the background, which can take days. Until it finishes, someone who already used your old phrase could still open files that haven't changed."

### 4.2 Change phrase (you have it)

1. Enter the current phrase (the redesigned check, §3).
2. The question (§4.1).
3. Show and confirm the new phrase (today's `RecoveryPhraseSetup`).
4. Save (§4.5). Toast: `Recovery phrase changed.`
5. "Someone may have it" only (phase 5): an optional last step, `Delete older private versions` (§4.4).

**Private items before phase 5.** Until private scopes have their own key pair (§5), private history can't move to a new phrase:
- "No": private history retires with the 30-day grace, as today. The copy adds: "Older versions of your private items stay with your old phrase for 30 days, then Luna removes them. Your private items back up again from the start."
- "Someone may have it": old private copies are removed **at once**. The copy adds: "Older versions of your private items can't be kept."

Once phase 5 lands, both lines go away.

### 4.3 Get a new phrase (you lost it)

1. Collapsible row → `Get a new phrase` opens a ConfirmModal (`warning` haptic) that names what's lost: "Private items backed up with your old phrase can't be opened anymore." Plus, for shared backups: "Your shared cloud backups stay open to you with the new phrase."
2. The question (§4.1). The private line follows the answer: "No" → "Luna keeps them for 30 days in case you find your phrase, then removes them." "Someone may have it" → "Luna removes them now."
3. Re-enter your Luna password, in a field in the same modal.
4. Show and confirm the new phrase.
5. Save (§4.5). Toast: `New recovery phrase saved.` With "No", the card then shows the old-phrase copies row.

### 4.4 "Someone may have it": moving to the new key in the background

The leak closes over days instead of never, and no backup waits on it.

**Right away.** The save marks the backup, and the run it queues starts key version N+1 with the dedup key of version N (§4.5). That run, and every one after it, works as it does today: every chunk is looked up in the backup's dedup scope (`run.rs` `CopyState::chunk` → `db::find_chunk`), which hasn't changed. Unchanged chunks stay in their version-N packs, and new and changed chunks go into new packs under N+1. The new snapshot is sealed under N+1 and points at packs from both versions.

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

**Private items (phase 5):** Luna can't open private packs, so it can't move them. "Someone may have it" starts a new private scope, and its first backup packs every file still on the drive again from the source files. Older versions and deleted files that exist only in the old scope stay there, now opened by the new phrase (§5) but also by anyone who already used the old phrase. So when you still have your phrase, the flow ends with an optional step: `Delete older private versions`, which names what's lost (earlier versions and deleted files that exist only in the cloud). Skipping it keeps them, and the copy says the old phrase may still open them.

### 4.5 The save

One endpoint, `PUT /api/v1/cloud/phrase`:

| Field | Values | Notes |
|---|---|---|
| `proof` | `old_signature` or `password` | None only for the first setup, when no phrase is set yet |
| `exposed` | `true` / `false` | The §4.1 answer. Required whenever a phrase is set |
| new keys | as today | `seal_public`, `auth_public`, `self_sealed` |

Phase 5 adds `rescoped` when the proof is the old phrase (§5).

**Proof:**
- Old phrase: the browser calls `POST /api/v1/cloud/phrase/challenge`, then signs the challenge with the **old** auth key under a new domain, `phrase-replace`. The PUT takes the challenge (`take_challenge`, single use) and verifies against the stored `auth_public`. A separate domain means a phrase-check signature can never be replayed as a replacement.
- Password: `auth.verify_password_for_user` (`auth.rs`). A wrong password should count toward the same lockout as a wrong sign-in; check that it does.

**In one SQLite transaction:**
1. Save the new user keys (`set_user_keys`, as today: the new phrase shows "Not checked yet" until its first check).
2. For every shared version whose saved reader list (`cloud_recipients:<backup>:<version>` meta) includes this person: replace their `seal_public` in that meta. `ensure_key` then sees the same readers, so an unexposed replacement starts no new version.
3. `exposed` only: mark each of those backups to rotate (`cloud_rotate:<backup>` meta, "keep dedup"). The save does **not** create version N+1 itself: a run publishes sealed copies to every recipient only when `ensure_key` starts the version during that run (`run.rs`, `is_new`). So `ensure_key` reads the mark, starts N+1 with version N's dedup key, and clears the mark, and the run then publishes N+1 to everyone on the backup, Admins included, through the path that already works. The save queues a run for each marked backup so new files are shut off from the old phrase within minutes, not at the next 6-hour run.
4. Queue a re-seal job for this person.
5. Private: retire the active scope with the 30-day grace when not exposed, and with no grace when exposed. From phase 5 on, a replacement proven with the old phrase keeps the scope instead (§5).

**After the transaction, in the background (the same pattern as today's `publish_users`):** the re-seal job writes a sealed, signed copy of every version key this person is on, plus the new user list. "Every version this person is on" = every version whose saved reader list includes them. That matches the copies they hold today: removing someone from a backup starts a new version without them, and keeps their copies of older versions (`keys.rs` test: "Bob's old copy stays for version 1 only"). If removal ever starts deleting old copies, this set must skip versions they were removed from. Each copy replaces the old phrase's copy under the same name. The job is retried on every run until it finishes. Until then, `GET /api/v1/cloud/phrase` reports `resealing: true`, and the card says "Updating your cloud backups to the new phrase…".

**Checked 2026-10-20, and what phase 3 adds because of it:**
- **Password re-entry has no lockout.** `auth.verify_password_for_user` (`auth.rs`) only compares the hash; the per-account lockout lives in the login path (`login_user_key` in `api/auth.rs`). Phase 3 runs the password proof through the same per-account bucket, so the lost flow can't be used to guess passwords. (`api/search.rs` calls the same function and has the same gap; fix it there too.)
- **Connect's B2 buckets keep every old version.** `providers.CreateBucket` (`connect/internal/providers/b2.go`) sets no lifecycle rules, and an upload to an existing name adds a new version on B2 instead of replacing it. So an old phrase's sealed copies would stay in the bucket, out of sight but not gone, and every overwrite is billed forever. Phase 3 (Connect side): create buckets with B2's "keep only the last version" lifecycle rule (`daysFromHidingToDeleting: 1`, no `daysFromUploadingToHiding`), and apply it to existing buckets with `b2_update_bucket`. "Replaced" is then true within a day. The local store already overwrites in place.

## 5. Phase 5: one key pair per private scope

**Why a format change.** Each private pack carries its own key, sealed to the owner's public key, **inside the pack header** (`format.rs` `finish`), and the pack id is the SHA-256 of the whole pack. Trees, metadata and the scope's dedup key are sealed straight to the owner too (`private.rs` `seal_tree`, `seal_meta`, `seal_dedup`). Re-sealing any of them would change the pack, so keeping history across a new phrase would mean uploading everything again.

**The change:**
- When Luna makes a private scope, it also makes a random X25519 + ML-KEM key pair for it. It seals the secret half to the owner's public key, keeps only the public half and the sealed secret, and wipes the secret from memory. Luna already holds the scope's dedup key, so this matches what it holds today. What it never keeps is anything that opens a private pack.
- Pack keys, trees, metadata and the dedup key are sealed to the **scope** public key instead of the owner's. Same purposes and `aad` as today.
- `ScopeRecord` (`pscopes/<scope>`, signed by Luna) gains `scope_public` and `sealed_scope_secret` (purpose `luna-private-scope-secret-v1`, same `aad` binding). `seal_public` and `auth_public` stay the owner's, for checking who may open the scope on Connect.
- DB: `private_scopes` gains `scope_public` and `sealed_scope_secret`. `ensure_scope` stops comparing `seal_public` with the owner's key: a scope retires only when a save says so, never because keys differ.
- Early development, no migrations: switch the format and drop today's direct-to-owner sealing.

**During a change (you have your phrase):** after step 3 of §4.2, the browser holds both the old and the new keys. It:
1. fetches the person's scopes from a new `GET /api/v1/cloud/phrase/scopes` (scope id plus `sealed_scope_secret`);
2. opens each secret with the old phrase's key and seals it to the new public key;
3. sends them in the PUT as `rescoped: [{ scope, sealed_scope_secret }]`.

Luna stores them in the same transaction and republishes each `pscopes/<scope>` record with the new owner keys, replacing the old one. A scope the browser couldn't re-seal (missing or damaged record) retires with the 30-day grace, as today, and the toast says how many.

**If exposed,** Luna also starts a new scope for new data (new key pair and new dedup key); the old one stays as history. `Delete older private versions` retires the old scope with no grace.

**Readers:** Connect's unlock (`privateUnlock.js`) and `shared/ui/lib/cloud/cloudPrivate.js` (`privateUnwrap`) gain one step: open `sealed_scope_secret` with the phrase's key, then use the scope secret wherever they use the owner secret today. Restore after database loss (`private_recover.rs`) gets the same step.

**Test vectors:** extend the shared crypto vectors (`crates/lunad/src/backup/cloud/crypto.rs`, `shared/ui/lib/cloud/backupCrypto.test.js`) with one scope key pair, a sealed scope secret, and a pack key sealed to it, so Rust and the browser agree byte for byte.

## 6. Decisions

All decided 2026-10-20:

1. **Last Admin with a phrase loses their phrase:** allowed, with no extra warning. With §4's re-sealing nothing shared is lost. The block stays only on demoting or removing that Admin.
2. **Change needs no password:** proving the old phrase is enough. Lost still asks for the Luna password.
3. **"Delete now" for old-phrase copies:** on both the card and the shield sheet.
4. **One question decides the handling:** "Could someone else have your phrase?", asked whether you still have it or not (§4). Having it only changes the proof.
5. **Can't have it:** no new key version. Luna re-seals every version to the new phrase, and nothing uploads again.
6. **May have it:** a new key version that keeps the dedup key, with readers that open each pack with the version that sealed it, and old packs moved to it in the background (§4.4). Private versions only in the cloud, which Luna can't move, get an optional `Delete older private versions` step when you still have your phrase; if you skip it, they stay and the copy says so. When you've lost it, old private copies are removed at once.

## 7. Around the card

- **Phrase before the first cloud backup.** In `ProtectSheet`, "Back up to the cloud" with no phrase opens `RecoveryPhraseSetup` inline and creates the backup after the phrase is saved. Server side, `POST /api/v1/cloud/backups` refuses with 409 `needs_phrase` when the caller has none, so the held-without-phrase state can't be created. Shared backups started by a Member while no Admin has a phrase still wait, with today's copy.
- **Dashboard.** With the gate in place, `dashboard/no-phrase` can't happen for new backups. Drop the scenario. The `check-phrase` intent opens the redesigned check.
- **Copy fixes.** `NO_PHRASE` stays "Settings → Cloud backup", which becomes true. Say "phrase", never "words", for the phrase itself (AGENTS.md wall of shame). Shipped copy to fix:
  - `RecoveryPhraseCheck.jsx`: "Check my words", "Type your recovery words…", "Could not check your words…", "Your words match…"
  - `RecoveryPhraseCard.jsx`: "…locked with recovery words only you know…", "Lost your recovery words?", "Enter your current words", "Enter your current recovery words first…"
  - `RecoveryPhraseSetup.jsx`: "Select the words and copy them by hand", "Type these words from your list…" (name the positions instead: "Type words 3, 7 and 11 of your phrase")
  - `needsYouBackups.js`: "Make sure your recovery words still open…"
  - `RestoreForm.jsx` and Connect's `UnlockCard.jsx`: placeholder "Your recovery words, with spaces between them"
  - `cloud_phrase.rs`: "Those words don't match the recovery phrase…" → "That doesn't match the recovery phrase set for your account."
  - Fine as they are: lengths and positions ("12 words", "Word 3", "has 18 words. It needs 12 or 24.", "Check each word.")
- **Last-Admin guard.** No change: replacing a phrase stays allowed, and `users.rs` keeps blocking demote and remove (§6, decision 1).

## 7a. Before implementation

- **Done 2026-10-20:** `docs/protect-rebuild/plan.md` points here, and the gallery `#` URL bug is fixed.
- **Linking a Luna to Connect lives in About → Advanced** (`UpdateSourceCard` → `ConnectDeviceCodeForm`). The new Luna Connect category shows only once a token exists, so linking stays there. Decide whether that's fine, or whether Luna Connect should always show to Admins with a "Link this Luna" state. Doesn't block phase 1.

## 8. Phases

Each phase ships on its own and leaves Luna working.

1. **Placement and card states:** remove External services, add the Cloud backup and Luna Connect categories, the status fields, the card table in §3, the copy fixes. Web, plus a small status change in `cloud_phrase.rs`.
2. **Gate:** phrase before the first cloud backup (ProtectSheet inline setup, plus the 409 on create).
3. **Replacing a phrase:** the save in §4.5 (proof, `exposed`, the transaction, the re-seal job), the §4.1 question, both flows, the check redesign, and readers that open each pack with the version that sealed it (§4.4). Private items follow §4.2. "Someone may have it" starts its new version here, but old packs stay under the old key until phase 4, so its copy in this phase says: "Your old phrase stops working right away. Files you add or change from now on open only with the new phrase. Older copies still open for anyone who already used your old phrase."
4. **Background move** for shared backups (§4.4): the pack move on the idle trickle, snapshot rewrites, the `Moving to your new phrase` status, the pause when storage fills. The "Someone may have it" copy switches to the §4.1 wording.
5. **Private history:** the per-scope key pair (§5), the browser re-seal in the change flow, the Connect and restore readers, the test vectors, `Delete older private versions`. The private lines in §4.2 go away.

## 9. Gallery scenarios to add

Fix the gallery's `#` URL bug (§1) first, or none of these load their seed.

- `settings/phrase-member-not-set`: a Member, Connect on, no phrase. The card shows; with no Admin phrase it adds the shared-backups line.
- `settings/connect-off`: neither Cloud backup nor Luna Connect in the sidebar.
- `settings/phrase-set-check-due`: pill `Check due`, check is the primary action.
- `settings/phrase-change`: old phrase, then "I want a new phrase", then the new phrase. A wrong old phrase is refused.
- `settings/phrase-change-exposed`: old phrase, then "Someone may have it". The copy says what can't be taken back.
- `settings/phrase-lost-exposed`: lost phrase, then "Someone may have it". The private line says Luna removes old copies now.
- `settings/phrase-moving`: a backup row and the card show `Moving to your new phrase · 40%`, with no problem state.
- `settings/phrase-moving-full`: Connect storage fills mid-move. The move pauses and says what to do; nothing old is deleted.
- `settings/phrase-lost`: the confirm names what's lost, needs the password, then shows the old-phrase copies row.
- `settings/phrase-resealing`: right after a save, the card says "Updating your cloud backups to the new phrase…" until the re-seal job finishes.
- `files/cloud-backup-no-phrase`: "Back up to the cloud" opens setup first.
- Drop `dashboard/no-phrase` (§7).
