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
- **No last-Admin guard on replacement.** Protect plan §5 step 7 says replacing the last Admin's phrase is blocked. `users.rs` guards only demote and remove; `set_phrase` has no check.
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
- Status additions to `GET /api/v1/cloud/phrase`: `last_checked_at`, `admin_has_phrase`, `old_phrase_copies {count, removed_at}` (move it here from the backup rows, or keep both), `last_phrase_admin` (am I the only Admin with a phrase).
- **Check my phrase** gets the first-class redesign asked for in `dashboard/check-overdue`: title `Check my phrase`, one word box per position (paste spreads across boxes, BIP39 autocomplete, a word turns invalid when it isn't on the list), a 12/24 switch, and a clear right/wrong outcome. The same component serves the first step of a change, and the dashboard reminder.

## 4. Three reasons to replace a phrase

People replace a phrase for three different reasons, and each needs different handling:

| | **New phrase** (have the words, they're safe) | **Leaked** (have the words, someone else may too) | **Lost** (don't have the words) |
|---|---|---|---|
| Entry | `Change phrase` → "I want a new phrase" | `Change phrase` → "Someone else may have seen it" | `Lost your recovery phrase?` → `Get a new phrase` |
| Proof | Old words | Old words | Luna password |
| Older shared versions | Re-sealed to the new phrase | Re-sealed to the new phrase | Re-sealed to the new phrase |
| New shared data | Same key version, nothing uploads again | New key version | New key version |
| Private history | Kept | Kept (phase 4) | **Lost.** Old copies stay 30 days in case the words turn up |
| New private data | Same scope | New scope | New scope |
| Old-phrase copies on Connect | Deleted | Deleted at once | Shared: deleted at once. Private: kept 30 days |
| Can't be undone | — | Anything already opened or downloaded with the old words | — |

**Why each row:**
- Older shared versions are re-sealed in all three cases. Luna holds those keys anyway (§1), so this gives nobody anything new. If the old phrase leaked, whoever has it could already open those versions; re-sealing only gives the owner their access back. So losing a phrase costs **private history only**, and the Lost confirm can say exactly that.
- New key versions (and a new private scope) for Leaked and Lost, because someone else may hold the old words. New data is then sealed only to the new phrase. A lost phrase on paper can be found, so Lost counts as possibly leaked.
- Deleting old-phrase copies "at once" stops a leaked phrase from opening anything new on Connect. It can't take back what was already downloaded, and the Leaked confirm says so.

### 4.1 Change phrase (I still have my words)

1. Enter the current words (the redesigned check). The browser signs a fresh challenge with the **old** auth key.
2. One question, two `CardButton`s: **"Why are you changing it?"**
   - `I want a new phrase`: "Your current words stay safe. Nothing uploads again."
   - `Someone else may have seen it`: "Luna locks new backups to the new phrase and removes the old phrase's copies. Anything already opened with the old words can't be taken back. Your shared cloud backups upload again, which can take days."
3. Show and confirm the new words (today's `RecoveryPhraseSetup`).
4. `PUT /api/v1/cloud/phrase` with `{ mode: "change" | "leaked", old_signature, …new keys }`. Luna checks `old_signature` against the stored `auth_public` in the same request, so the proof can't be replayed for something else.
5. In the same transaction as the key save, Luna rewrites what the two automatic rules compare (§1), or they undo a "change" on the next run:
   - For every shared version the person is on: re-seal the key to the new public key, re-sign it, and rewrite that version's `cloud_recipients` meta and signed recipient record. For `change`, `ensure_key` then sees the same readers: no new version. For `leaked`, Luna then starts a new version for new data.
   - Private: §5.
6. Toast: `Recovery phrase changed.`

### 4.2 Leaked, before phase 4

Until private scopes have their own key pair (§5), private history can't move to the new phrase. A leaked phrase would keep opening it for the 30-day grace, so in the Leaked case **old private copies are removed at once**. The step-2 copy for Leaked adds: "Older versions of your private items can't be kept." Once phase 4 lands, this line goes away.

A plain "change" before phase 4 keeps today's behavior: private history retires with the 30-day grace, and the step-2 copy says so.

### 4.3 Get a new phrase (lost words)

1. Collapsible row → `Get a new phrase` opens a ConfirmModal (`warning` haptic) that names what's lost:
   - "Private items backed up with your old phrase can't be opened. Luna keeps them for 30 days in case you find the words, then removes them."
   - "Your shared cloud backups stay open to you. They upload again from the start, which can take days."
   - When `last_phrase_admin` is set: a line about what that means (§6, question 1).
2. Re-enter your Luna password (`password` field in the same modal). The PUT sends `{ mode: "lost", password, …new keys }`. This stops a walk-up phrase swap.
3. Show and confirm the new words.
4. Toast: `New recovery phrase saved.` The card then shows the old-phrase copies row.

`PUT` with no `mode` stays allowed only when no phrase is set yet (first setup).

## 5. The hard part: keeping private history

**Shared backups need no format change.** Luna keeps every key version in `backup_keys` and re-seals them itself, in all three cases. After Luna loses its database, it holds only the versions a restoring browser handed back, so a replacement right after a recovery re-seals only those.

**Private items need a format change.** Each private pack carries its own key, sealed to the owner's public key, **inside the pack header** (`format.rs` `finish`). The pack id is the SHA-256 of the whole pack. Re-sealing a key would change the pack, so keeping history would mean uploading everything again.

Proposal: **one key pair per private scope.**

- Each private scope gets a random X25519 + ML-KEM key pair. Luna stores only its public half. The secret half is sealed to the owner's phrase key and stored as one signed record per scope (`pscopekeys/<scope>`).
- Pack keys, trees and metadata are sealed to the **scope** public key, not the owner's.
- A change or leak = the browser opens each scope secret with the old phrase, re-seals it to the new one, and Luna signs and uploads that one record per scope. The old-phrase record is deleted. No pack moves.
- Leaked additionally starts a fresh scope (new key pair, new dedup key) for new data. The old scope stays as history, now opened by the new phrase.
- Luna still never holds anything that opens a private pack, so the "not Luna, not an Admin, not us" promise holds.
- `ensure_scope` stops comparing the scope's `seal_public` with the owner's key. A scope retires only when the save says so (`leaked` starts a new scope, `lost` retires the old one), never because keys differ.
- Early development, no migrations: switch the format and drop today's per-owner sealing.

Restore after database loss (`private_recover.rs`) and the Connect browser (`connect/web` `privateUnlock.js`) gain one step: open the scope key first, then the packs.

## 6. Questions for you

1. **Last Admin with a phrase loses their words.** Protect plan §5 step 7 says block it, but blocking leaves them stuck. With §4's re-sealing, nothing shared is lost anymore: Luna re-seals every version to the new phrase. Proposal: allow it with no extra warning, and keep the block only on demote and remove.
2. **Do Leaked and Lost need a full re-upload?** The 2026-10-17 decision gives every new key version a fresh dedup key, so newcomers can't open old versions through shared packs. In Leaked and Lost nobody new joins: every current reader already holds the current version's key, and the person replacing their phrase gets it re-sealed (§4). Reusing the current version's dedup key there would point new snapshots at that version's existing packs, so nothing uploads again. The old phrase could only open packs it could already open. Proposal: keep the dedup key for these two, and keep a fresh one when someone joins.
3. **Password re-entry for Change too**, or is proving the old words enough? Proposal: the old words are enough.
4. **"Delete now" for old-phrase copies on the card**, or only on the shield sheet where it already shows? Proposal: both.

## 7. Around the card

- **Phrase before the first cloud backup.** In `ProtectSheet`, "Back up to the cloud" with no phrase opens `RecoveryPhraseSetup` inline and creates the backup after the phrase is saved. Server side, `POST /api/v1/cloud/backups` refuses with 409 `needs_phrase` when the caller has none, so the held-without-phrase state can't be created. Shared backups started by a Member while no Admin has a phrase still wait, with today's copy.
- **Dashboard.** With the gate in place, `dashboard/no-phrase` can't happen for new backups. Drop the scenario. The `check-phrase` intent opens the redesigned check.
- **Copy fixes.** `NO_PHRASE` stays "Settings → Cloud backup", which becomes true. Rename `Check my words` to `Check my phrase` everywhere.
- **Last-Admin guard.** Per §6 question 1.

## 8. Phases

1. **Placement and card states:** remove External services, add the Cloud backup and Luna Connect categories, the status fields, the card table in §3, the copy fixes. Web, plus a small status change in `cloud_phrase.rs`.
2. **Gate:** phrase before the first cloud backup (ProtectSheet inline setup, plus the 409 on create).
3. **The three cases:** the `mode` field, old-signature proof, password re-entry, the two-button question, the Lost confirm, the check redesign. Luna re-seals every shared version to the new phrase and rewrites its reader list in the save's transaction. Leaked and Lost start new key versions; a plain change doesn't. Private items follow §4.2 in this phase.
4. **Private history:** the per-scope private key pair (format change, plus recover and Connect updates); `ensure_scope` stops retiring on key mismatch.

## 9. Gallery scenarios to add

Fix the gallery's `#` URL bug (§1) first, or none of these load their seed.

- `settings/phrase-member-not-set`: a Member, Connect on, no phrase. The card shows; with no Admin phrase it adds the shared-backups line.
- `settings/connect-off`: neither Cloud backup nor Luna Connect in the sidebar.
- `settings/phrase-set-check-due`: pill `Check due`, check is the primary action.
- `settings/phrase-change`: old words, then "I want a new phrase", then new words. Wrong old words are refused.
- `settings/phrase-leaked`: old words, then "Someone else may have seen it". The copy says what can't be taken back.
- `settings/phrase-lost`: the confirm names what's lost, needs the password, then shows the old-phrase copies row.
- `files/cloud-backup-no-phrase`: "Back up to the cloud" opens setup first.
- Drop `dashboard/no-phrase` (§7).
