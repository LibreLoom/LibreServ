# Recovery phrase card — plan for review (2026-10-20)

Planning only. Nothing here is built yet.

## 1. What's true today

- **The card exists, but most people can't reach it.** `RecoveryPhraseCard.jsx` is the last card inside `CloudBackupCategory`. That category is part of **External services**, which `settingsCategories.js` marks `adminOnly`. So a Member never sees the card. An Admin finds it at the very bottom of the page, under Remote access, Cloud backup and the restore cards.
- **Copy points to a place that doesn't exist.** `private_run.rs` `NO_PHRASE` says "Set up your recovery phrase in Settings → Cloud backup". There is no such category. The gallery scenario `dashboard/no-phrase` checks for "Settings → Security / Devices", which is wrong too.
- **Cloud backup starts without a phrase.** `POST /api/v1/cloud/backups` and `ProtectSheet.jsx` never look at the phrase. The backup is created and then sits held: "Set up your recovery phrase…" for private items, "Waiting for an Admin…" for shared ones. That is the state the `dashboard/no-phrase` note calls impossible-by-design.
- **"Change" and "Get a new phrase" do the same thing.** Both call `openSetup(true)`. The check-first `{kind: "change"}` dialog is wired up but nothing opens it.
- **Replacing a phrase needs nothing but a live session.** `PUT /api/v1/cloud/phrase` asks for no old words and no password. Anyone at an unlocked browser can swap someone's phrase. Their private history is then marked `old_phrase` (`private::ensure_scope`) and removed 30 days later.
- **Replacing a phrase is expensive, and it happens automatically.** Two rules compare stored keys on every run:
  - `keys::ensure_key` compares the saved reader list (`cloud_recipients:<protection>:<version>` meta, public keys included) with today's. Any difference starts a new key version with a fresh dedup key (decision 2026-10-17), so every shared backup the person is on uploads again in full.
  - `private::ensure_scope` compares the active scope's `seal_public` with the owner's key. A difference retires the scope as `old_phrase`.
  - Today these fire on every replacement, even when the old words were never lost.
- **Luna keeps every shared key version.** `backup_keys` rows are never deleted (`db::list_backup_keys`), so Luna can re-seal older versions to someone's new key itself.
- **No last-Admin guard on replacement.** Plan §5 step 7 says replacing the last Admin's phrase is blocked. `users.rs` guards only demote and remove; `set_phrase` has no check.
- **Already built, and the card can reuse it:** the 90-day `check_due`, the old-phrase copies with their 30-day grace (`old_phrase_copies` on backup rows, and `remove_old_copies` in `private_backups.rs`), the Member-before-Admin hold, and `RecoveryPhraseCheck` with `onVerified`.

## 2. Where the card lives

A new Settings category, **Cloud backup** (cloud icon):

- **Shown only while Connect is active**, the same rule External services uses today (`visibleCategories(…, connectActive)`). With Connect off, there's no category and no card.
- **Shown to every role.** The phrase belongs to each person: Members need one for their private items, and for shared backups they're on.
- Order: **Recovery phrase** (everyone) → Cloud backup list (everyone; the API already limits it to what they may see) → Cloud restore / Private restore (these already hide themselves from non-Admins).
- External services keeps Remote access only.

Why not Security: the user already questioned "Security / Devices", and a phrase means nothing without Connect, while Security is always shown. The category name also makes the existing `NO_PHRASE` copy true.

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
| Lost words | Collapsible row: `Lost your recovery phrase?` | `Get a new phrase` (accent, see §4.2) |

- "Not set" copy for a Member while no Admin has a phrase adds one line: "Shared backups also wait for an Admin to set up theirs." The status call needs `admin_has_phrase` for this.
- Status additions to `GET /api/v1/cloud/phrase`: `last_checked_at`, `admin_has_phrase`, `old_phrase_copies {count, removed_at}` (move it here from the backup rows, or keep both), `last_phrase_admin` (am I the only Admin with a phrase).
- **Check my phrase** gets the first-class redesign asked for in `dashboard/check-overdue`: title `Check my phrase`, one word box per position (paste spreads across boxes, BIP39 autocomplete, a word turns invalid when it isn't on the list), a 12/24 switch, and a clear right/wrong outcome. The same component serves Change step 1 and the dashboard reminder.

## 4. Changing vs. losing — two different flows

### 4.1 Change phrase (I still have my words)

1. Enter the current words (the redesigned check). The browser signs a fresh challenge with the **old** auth key.
2. Show and confirm the new words (today's `RecoveryPhraseSetup`).
3. `PUT /api/v1/cloud/phrase` with `{ mode: "change", old_signature, …new keys }`. Luna checks `old_signature` against the stored `auth_public` in the same request. The check and the save are one step, so the proof can't be replayed for something else.
4. Old words were never exposed, so **this is not a key loss**. In the same transaction as the key save, Luna rewrites what the two automatic rules compare (§1), or they undo the Change on the next run:
   - Shared backups: for every version the person is on, Luna re-seals the key to the new public key, re-signs it, and rewrites that version's `cloud_recipients` meta and signed recipient record with the new key. `ensure_key` then sees the same readers: no new version, no re-upload.
   - Private items: see §5. Until phase 4, the private half of a Change works like Lost (the scope retires with the 30-day grace), and the Change copy says so.
   - Old-phrase sealed copies are deleted from Connect once the new ones are written.
5. Toast: `Recovery phrase changed.`

### 4.2 Get a new phrase (lost words)

1. Collapsible row → `Get a new phrase` opens a ConfirmModal (`warning` haptic) that names what's lost:
   - "Private backups made with your old phrase can't be opened. They stay for 30 days in case you find the words, then Luna removes them."
   - "Luna backs up your shared cloud backups again from the start. This can take days." (Today's behavior: new key version, fresh dedup key.)
   - When `last_phrase_admin` is set: "Older copies of shared backups can't be opened by anyone after this." See §6, question 1.
2. Re-enter your Luna password (`password` field in the same modal). The PUT sends `{ mode: "lost", password, …new keys }`. This stops a walk-up phrase swap.
3. Show and confirm the new words.
4. Toast: `New recovery phrase saved.` The card then shows the old-phrase copies row.

`PUT` with no `mode` stays allowed only when no phrase is set yet (first setup).

## 5. The hard part: keeping history across a Change

The phrase seals two kinds of things. Each needs its own answer.

**Shared backups: no format change needed.** Luna keeps every key version in `backup_keys`, so it re-seals all of them to the new key itself (§4.1 step 4). The browser isn't needed. (The 2026-10-17 note "old key versions are never re-sealed" was about a recipient set that loses someone. That stays as it is.) After a database loss, Luna has only the versions the restoring browser handed back, so a Change right after a recovery re-seals only those.

**Private items. This needs a format change.** Each private pack carries its own key, sealed to the owner's public key, **inside the pack header** (`format.rs` `finish`). The pack id is the SHA-256 of the whole pack. Re-sealing a key would change the pack, so keeping history would mean uploading everything again.

Proposal: **one key pair per private scope.**

- Each private scope gets a random X25519 + ML-KEM key pair. Luna stores only its public half. The secret half is sealed to the owner's phrase key and stored as one signed record per scope (`pscopekeys/<scope>`).
- Pack keys, trees and metadata are sealed to the **scope** public key, not the owner's.
- Change phrase = the browser opens the scope secret with the old phrase and re-seals it to the new one. Luna signs and uploads that single record. No pack moves.
- Luna still never holds anything that opens a private pack, so the "not Luna, not an Admin, not us" promise holds.
- `ensure_scope` stops comparing the scope's `seal_public` with the owner's key. A scope retires only when a Lost save says so (`mode: "lost"`), never because keys differ.
- Get a new phrase still starts a fresh scope (with a new key pair and dedup key) and retires the old one. Nothing changes there.
- Early development, no migrations: switch the format and drop today's per-owner sealing.

Restore after database loss (`private_recover.rs`) and the Connect browser (`connect/web` `privateUnlock.js`) gain one step: open the scope key first, then the packs.

## 6. Questions for you

1. **Last Admin with a phrase loses their words.** Plan §5 step 7 says block it. But blocking leaves them stuck, since every new shared version is still sealed to a key nobody holds. Proposal: allow it and warn (§4.2), and keep the block only on demote and remove. OK?
2. **Password re-entry for Change too**, or is the old-phrase signature enough? Proposal: the signature is enough.
3. **"Delete now" for old-phrase copies on the card**, or only on the shield sheet where it already shows? Proposal: both. The card is where someone looks after getting a new phrase.

## 7. Around the card

- **Phrase before the first cloud backup.** In `ProtectSheet`, "Back up to the cloud" with no phrase opens `RecoveryPhraseSetup` inline and creates the backup after the phrase is saved. Server side, `POST /api/v1/cloud/backups` refuses with 409 `needs_phrase` when the caller has none, so the held-without-phrase state can't be created. Shared backups started by a Member while no Admin has a phrase still wait, with today's copy.
- **Dashboard.** With the gate in place, `dashboard/no-phrase` can't happen for new backups. Change the scenario to "an Admin removed their phrase via Lost and hasn't finished setup", or drop it. The `check-phrase` intent opens the redesigned check.
- **Copy fixes.** `NO_PHRASE` stays "Settings → Cloud backup", which becomes true. Rename `Check my words` to `Check my phrase` everywhere.
- **Last-Admin guard.** Add it to `set_phrase` per the answer to §6 question 1.

## 8. Phases

1. **Placement and card states:** the new category, the status fields, the card table in §3, the copy fixes. Web, plus a small status change in `cloud_phrase.rs`.
2. **Gate:** phrase before the first cloud backup (ProtectSheet inline setup, plus the 409 on create).
3. **Split Change and Lost:** the `mode` field, old-signature proof, password re-entry, the Lost confirm, the check redesign. Change re-seals every shared version and rewrites its reader list in the save's transaction (`keys::ensure_key` must then see no change). Private items still retire on Change in this phase, and the copy says so.
4. **Private history across Change:** the per-scope private key pair (format change, plus recover and Connect updates); `ensure_scope` stops retiring on key mismatch.

## 9. Gallery scenarios to add

- `settings/phrase-member-not-set`: a Member, Connect on, no phrase. The card shows; with no Admin phrase it adds the shared-backups line.
- `settings/connect-off`: no Cloud backup category at all.
- `settings/phrase-set-check-due`: pill `Check due`, check is the primary action.
- `settings/phrase-change`: the old-words step, then new words. Wrong old words are refused.
- `settings/phrase-lost`: the confirm names what's lost, needs the password, then shows the old-phrase copies row.
- `settings/phrase-lost-last-admin`: the extra warning line.
- `files/cloud-backup-no-phrase`: "Back up to the cloud" opens setup first.
- Fix `dashboard/no-phrase` (its check text, or drop it, per §7).
