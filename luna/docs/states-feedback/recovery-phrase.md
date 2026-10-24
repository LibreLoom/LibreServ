# Recovery phrase: check modal redesign and phrase as a required setup step

## 0. What's true today

**How a Luna ends up with no phrase.** Setup is Welcome → System check → Account → Name → Done, and none of those steps makes a phrase. A phrase is made only from:
- the Recovery phrase card (Settings → Cloud backup, Connect on only),
- the inline setup in ProtectSheet, when someone first picks "Back up to the cloud",
- `restoreFromPhrase` when no phrase is set yet.

The keys come from `derive(entropy, luna_id)`, so the browser first calls `POST /api/v1/cloud/identity`. That runs `identity::load_or_create_connected`, which makes the Luna id and signing key.

**Endpoints.**
- `GET`/`PUT /api/v1/cloud/phrase`
- `POST /api/v1/cloud/identity`
- `POST /api/v1/cloud/phrase/challenge`
- `POST /api/v1/cloud/phrase/check`
- `GET /api/v1/cloud/phrase/scopes` and `/kept-scopes`

All are in `luna/crates/lunad/src/api/cloud_phrase.rs`.

**What needs a phrase.** Only cloud backups:
- shared ones (`ops::check_new_backup`, the 409 in `cloud_backups.rs`, the key copies in `keys.rs`),
- private ones (`private_run.rs` `NO_PHRASE`),
- private and shared restore,
- the last-Admin guard in `users.rs`,
- the "hasn't set a recovery phrase" warning in `system_health.rs`.

Backups to local drives don't use it.

**Things found while checking**, which the briefs fix:
1. `register_public` is only called when an identity is first made (`identity.rs:137`). If Connect is off when the id is made, Connect never gets this Luna's signing key. Making the id during setup, while Connect is off by default, makes this the normal case.
2. `POST /cloud/phrase/check` answers 400 both for a wrong phrase and for an expired challenge. The web treats 400 as "wrong phrase", so a slow check is reported as a wrong phrase.
3. The downloaded phrase file has lines like `1. abandon`. Pasting it gives tokens like `1.`, and the check modal rejects them.
4. ProtectSheet and PhraseReplaceFlow each have their own copy of the show-and-confirm code from `RecoveryPhraseSetup.jsx`.

## 1. Decisions for you

**A. A Luna set up again (after a reset or a lost system disk) can no longer bring back its cloud backups through Luna.**
`known_luna_id` only gets the old Luna id back from key copies on drives that are already added (`connected_roots` reads the `drives` table). There are no drives during setup ("Now plug in a USB drive" comes after Done). So a phrase step during setup makes a new id every time:
- "Bring back cloud backups" (`CloudRestoreCard`) can't open the old records any more.
- The person also writes down a new phrase they don't need, when the restore needs their old one.
- No files are lost: Connect's web unlock (`connect/web/src/lib/cloudUnlock.js`) works from the account's list of Luna ids, so the old phrase still opens old backups there.
- **Recommended:** ship the setup step now, then a follow-up lunad change. When a drive is added that holds exactly one other Luna id, and this Luna's id has never been used (no cloud backups, snapshots or private scopes), Luna switches to the drive's id and clears every account's keys. The forced phrase screen then asks for "the recovery phrase you used before" and runs the restore. That follow-up is not in the briefs below; it waits for your yes.

**B. Members and later Admins.** Setup only covers the first Admin. The briefs add a required phrase screen at first sign-in for any account without a phrase, which is what makes "a Luna can't be without one" true for everyone. The web enforces it; lunad's existing 409 stays as a backstop. If you'd rather not require it for Members, drop part F2 and keep the card's "Not set up" state and `settings/phrase-member-not-set`.

**Taken in this spec (tell me if you want otherwise):**
- **The phrase is required at setup even with Connect off.** That's the plain reading of the decision. The 90-day reminder already only shows when you can see a cloud backup (`buildPhraseItem`), so a Luna without Connect isn't nagged.
- **Where the card lives:** Settings → Cloud backup, now shown to everyone all the time. With Connect off it shows the phrase card plus one line saying cloud backup needs Luna Connect.
  - Max questioned the phrase being under Security. The phrase only opens cloud backups. And "Settings → Cloud backup" is already the copy in lunad (`NO_PHRASE`, the 409).
  - The other option is Security, next to the "You" card. Say so if you prefer it.
- **The phrase length (12 or 24) is stored on Luna** (`phrase_words`). Then the check shows exactly the right number of boxes and needs no 12/24 switch. It shows only whether the phrase is 12 or 24 words, it stays in Luna's database, and Connect never gets it.

## 2. Design (a): the check modal

**What's asked.** Every word, in order (1…12 or 1…24).
- The check signs a challenge with a key made from the whole phrase, and Luna never sees any words. So Luna can't check 3 random words. Partial checks are only possible in the browser, while the new phrase is still on screen (setup confirm).
- **Box count:** taken from `phrase_words`. If it's 0 (unknown), a 12/24 switch shows, starting at 12. Pasting 12 or 24 words sets the count.

**Layout.**
- `ModalCard` size md, on `surface-secondary`.
- One lead sentence, then a mono counter on the right (`7 of 12`).
- A grid of numbered word boxes: `grid-cols-2 sm:grid-cols-3`, numbered across the rows in the same order the setup grid shows them.
- Each box is a `surface-primary` pill input with `aria-label="Word N"`.
- Suggestion chips go on their own row directly under the focused box, as today: outline `Button`s, `surface="secondary"`, at most 5.

**Each box's state, from the list only:**

| State | When | Looks like |
|---|---|---|
| Empty | nothing typed | plain |
| Typing | focused, and some list word starts with it | plain, chips showing |
| On the list | text is a list word | small `Check` icon at the end, `text-success`, fades in (`motion-safe:animate-in fade-in zoom-in-50 duration-150`) |
| Not on the list | no list word starts with it, or it's not a whole list word and the box lost focus | `border-error`, `AlertCircle` `text-error`, `aria-invalid`, `aria-describedby` → the line below |

Problems with the whole phrase (checksum, refused by Luna) never point at one word. That would be guessing (AGENTS rule 1).

**Keyboard.** All inside the input's own handlers; none of these are global shortcuts, so `useShortcut` doesn't apply.
- Box 1 has focus when the modal opens (`initialFocusRef`).
- When the typed letters match exactly one list word, its chip is highlighted already. English list words are unique by their first 4 letters.
- Space, or Enter with a chip highlighted: take the chip and move to the next box.
- Space or Enter in a box that already holds a list word: move to the next box.
- Enter in the last box, or when every box is filled: submit.
- Backspace in an empty box: go to the previous box, caret at the end.
- ArrowLeft at caret 0 / ArrowRight at the end: previous / next box.
- ArrowUp / ArrowDown: walk the chips (as today).
- Escape: ModalCard closes it.

**Paste** into any box goes through one `splitPhraseText(text)` helper:
- lowercases,
- splits on whitespace and commas,
- drops numbering like `1.`, `1)` or `#1`,
- trims punctuation.

Then:
- 12 or 24 words fill from box 1. If the length is known and different, nothing is filled and the line says `That's 24 words. Your recovery phrase has 12.`
- Any other count fills from the current box and never goes past the last one.

**Mobile.** `autoCapitalize="none"`, `autoCorrect="off"`, `spellCheck={false}`, `enterKeyHint="next"` (`"done"` on the last box). Box 1's placeholder is `Type or paste`; the other boxes have none.

**Submit.**
- The button is never disabled except while checking. There are no dead buttons.
- Empty boxes: shake, focus the first empty one, line `Fill in word 5.`
- A word not on the list: shake, focus it.
- Checksum fails (checked in the browser before any network call): `These 12 words don't form a recovery phrase. A word may be wrong or out of order.`
- Luna refuses (403): `That isn't the recovery phrase for your account. Check each word against what you wrote down.` After a refusal, a ghost button `Lost your phrase?` appears, when the caller passes `onLost`.
- Locked out (429): `Too many wrong tries. Wait a few minutes, then try again.` (`LOCKED_OUT_MESSAGE`)
- Challenge expired (400): Luna's message, `That check took too long. Start it again.`
- Anything else: `Could not check your phrase. Try again.`

The words stay in the boxes after every failure, so one can be fixed. They're wiped when the modal closes and on success.

**Success.**
- `onVerified(phrase)` is called.
- In check use, the caller closes the modal and fires one toast:
  - message `Your recovery phrase is correct.`
  - description `Luna will ask you to check it again in 90 days.`
  - The toast brings its own success haptic. This is true: `CHECK_DUE_AFTER` is 90 days.
- In the change flow it moves on to the next step, with no toast.

**Haptics.** None from typing or focus moves. `selection` when a chip is taken (already there). Every failure is `shakeElement` only, which fires the error haptic. No extra success haptic.

**Copy:**
- Title `Check my phrase`. The change flow keeps `Enter your current phrase` with button `Continue`.
- Lead `Type your 12 words in order, from where you wrote them down.` (the length is filled in). When the length is unknown: `Type your recovery phrase in order, from where you wrote it down.`
- Not on the list: `Word 4 isn't on the recovery phrase list. Check the spelling.` (several: `Words 4 and 9 aren't on…`)
- Button `Check`.

## 3. Design (b): the phrase as a setup step

**Order:** Welcome → System check → Account → **Recovery phrase** → Name → Done, with dots `n / 6`.
- Step id `phrase`, label `Recovery phrase`.
- It comes after Account because it needs the signed-in user.
- The phrase is never put in `step_data`. Only `phrase_set: true` is saved after the save succeeds.

**What the person sees (on the setup card, `surface-secondary`):**

1. **Show.**
   - On mount: `POST /api/v1/cloud/identity`, with the small line `Making your recovery phrase…` while it runs.
   - If that fails: Luna's message inline (`AlertCircle` + text), plus a `Try again` button.
   - Heading `Write down your recovery phrase`.
   - Lead `Your recovery phrase locks your cloud backups so only you can open them.` "cloud backups" is a `TermHint`: `Copies of your files kept online with Luna Connect. You can turn this on later.`
   - Second line `Write these 12 words on paper, in order. If you lose them, no one can open your cloud backups for you, including us.`
   - 12/24 switch with today's hint text, then the word grid.
   - Buttons `Print`, `Download`, `Copy` (outline), and primary `I wrote it down`.
   - Small line `Leaving this page before you finish makes a new phrase.` This is true, and a `beforeunload` guard covers it until the save.
2. **Confirm.**
   - Heading `Confirm your recovery phrase`.
   - `Type words 3, 7 and 11 from what you wrote down.` 3 random positions in different places, sorted. The 3 boxes are the same word boxes with chips.
   - Wrong word: shake, focus that box, `Word 7 doesn't match. Check what you wrote down.`
   - Buttons: outline `Back to the phrase`, primary `Save and continue`.
   - Save fails: Luna's message inline, or `Could not save your recovery phrase. Try again.`
   - Success moves to the next step. No toast: the step change is the result, as on the other setup steps.

**Resume.**
- Saved step `phrase` and `user.phrase_set` is true → go to Name.
- Saved step `name` with `phrase_set` false → go back to `phrase`.
- Signed out on `phrase` → the account sign-in form (the same rule as Name).

**lunad refuses to finish setup without a phrase.**
- `POST /api/v1/setup` with `setup_completed: true` returns 409, `code: "needs_phrase"`, unless the signed-in Admin has `user_keys`.
- Message: `Set up your recovery phrase before you finish setup.`
- No accounts yet (anonymous, on the LAN): 409 `Create your Luna account and its recovery phrase before you finish setup.`
- The remote 403 is checked first, as today.
- The Name step catches `needs_phrase` and sends the person back to the phrase step.
- No migration (early development).

**Afterwards.**
- `RecoveryPhraseCard` loses its "Not set up" state, the Member "Shared backups also wait…" line and `openSetup`.
- ProtectSheet loses its inline setup.
- `RecoveryPhraseSetup.jsx` is deleted.
- lunad's 409 `needs_phrase` on creating a cloud backup stays as a backstop, with copy that points at a reload (the reload brings up the phrase screen).

---

## Brief L (haiku): lunad

**Owned files:**
- `luna/crates/lunad/src/api/setup.rs`
- `luna/crates/lunad/src/auth/guard_tests.rs`
- `luna/crates/lunad/src/api/cloud_phrase.rs`
- `luna/crates/lunad/src/api/auth.rs` (only the `me` handler)
- `luna/crates/lunad/src/db.rs` (`user_keys` only)
- `luna/crates/lunad/src/backup/cloud/identity.rs`
- `luna/crates/lunad/src/api/cloud_backups.rs` (one string)
- `luna/crates/lunad/src/backup/cloud/private_run.rs` (one string)
- `luna/os/iso/e2e/run.py`
- Every file that only needs `phrase_words: 0` added to a `UserKeys { … }` literal: run `grep -rn "UserKeys {" luna/crates/lunad/src` and touch nothing else in those files.

**Changes:**

1. **`setup.rs`**
   - Add `"phrase"` to `VALID_STEPS`.
   - In `save_setup`, after the existing remote-anonymous 403 block and before writing anything: if `body.setup_completed == Some(true)`:
     - no users → `json_error_code(StatusCode::CONFLICT, "needs_phrase", "Create your Luna account and its recovery phrase before you finish setup.")`
     - otherwise the signed-in Admin must have `db::get_user_keys(&conn, &user.id)?.is_some()`, else 409 `needs_phrase` `"Set up your recovery phrase before you finish setup."`
   - Extend `valid_steps_cover_wizard` with `"phrase"`.
   - In `anonymous_setup_writes_are_lan_only`, change the "LAN client writes freely" assertion: `setup_completed` from a LAN peer with no account is now `CONFLICT`. Add one assertion that a progress-only body (`{"current_step":"preflight"}`) from the LAN is still `OK`.
2. **`guard_tests.rs`**
   - Add a helper `seed_phrase(app, cookie, csrf)`. It calls `POST /api/v1/cloud/identity`, then `PUT /api/v1/cloud/phrase` with `seal_public` and `auth_public` from `crate::backup::cloud` `vectors.json`, hex decoded and base64 encoded, and `self_sealed: "AA=="`.
   - Use the helper before every `setup_completed: true` that expects 200 (around line 401).
   - Rewrite `completing_setup_clears_step_data`:
     - (a) no account → 409 with `code == "needs_phrase"`;
     - (b) register, sign in, seed the phrase, finish → 200 and `step_data` cleared.
   - Add `finishing_setup_needs_the_admins_recovery_phrase`: a signed-in Admin without keys gets 409 `needs_phrase`; after `seed_phrase`, 200.
3. **`cloud_phrase.rs`**
   - `SetBody` gains `#[serde(default)] words: Option<u8>`. Anything other than `None`, 12 or 24 → 400 `"A recovery phrase has 12 or 24 words."`
   - Save it as `phrase_words` (`None` → 0).
   - `check` keeps it (`..keys` already does).
   - `status` adds `"phrase_words": keys.map_or(0, |k| k.phrase_words)`.
   - Remove `admin_has_phrase` (the function, the status field, and the tests `member_sees_whether_an_admin_has_a_phrase_but_not_their_own_state` and `member_only_phrase_does_not_count_as_an_admin_phrase`).
   - In `check`, a signature that doesn't match returns `StatusCode::FORBIDDEN` with the same message. The expired challenge and "no phrase set" answers stay 400.
   - Update `check_accepts_right_and_refuses_wrong_words_and_expired_challenges` to match.
   - New tests:
     - `words_is_stored_and_reported`: 24 in → status `phrase_words == 24`, and still 24 after a check.
     - `words_other_than_12_or_24_are_refused`.
4. **`db.rs`**
   - `user_keys` gets `phrase_words INTEGER NOT NULL DEFAULT 0`, in `CREATE TABLE` and through `ensure_column` where the other added columns are ensured.
   - `UserKeys.phrase_words: i64`, `USER_KEYS_COLUMNS`, `user_keys_from_row` and `set_user_keys` updated.
   - Fix every literal that `cargo check` points at with `phrase_words: 0`.
   - Extend `user_keys_crud` to round-trip 24.
5. **`auth.rs` `me`**
   - Add `"phrase_set": crate::db::get_user_keys(&conn, &user.id).ok().flatten().is_some()` to the signed-in JSON. The fallback JSON when the lock fails leaves it out; the web treats a missing value as "don't block".
   - Test: `me_reports_phrase_set` (false before a PUT, true after).
6. **`identity.rs`**
   - Add the meta key `cloud_identity_registered`, which holds the Luna id that was registered.
   - `register_public` returns `bool` (true on a 2xx).
   - New `fn ensure_registered(db: &crate::Db, connect: &ConnectService, identity: &Identity)`: if `connect.has_valid_device_code()` and the meta value isn't `identity.luna_id`, call `register_public`; on true, `db::set_meta`.
   - Take the DB lock only to read and write the meta value, never across the network call.
   - Call it from `load_or_create_connected` on both paths: after the early return that loads an existing identity (restructure so the lock is dropped first), and in place of the bare `register_public` after a mint.
   - Tests, using the existing `fake_connect` and `connect_to` helpers:
     - `an_identity_made_while_connect_was_unreachable_registers_on_the_next_load`: first load against `http://127.0.0.1:1`, then against `fake_connect`. The seen lines include one `POST …/signing-public`, and a third load sends none.
     - `no_device_token_means_no_registration_attempt`.
7. **Copy**
   - `cloud_backups.rs` NEEDS_PHRASE message → `"You need a recovery phrase first. Reload this page to set one up."`
   - `private_run.rs` `NO_PHRASE` → `"This private item's owner hasn't set up a recovery phrase yet, so its cloud backup can't start."`
8. **`os/iso/e2e/run.py`**
   - Add `set_test_phrase(lu)`. It reads `luna/crates/lunad/src/backup/cloud/vectors.json`, turns the hex into base64, calls `lu.post("/api/v1/cloud/identity")`, then `lu.req("PUT", "/api/v1/cloud/phrase", {seal_public, auth_public, "self_sealed": "AA==", "words": 12})`, and checks for 200.
   - Call it right before every `setup_completed: True` POST (lines ~416, 906, 1253, 1505, 1603, 1737, 1768, 1837), after the Admin is signed in.

**Acceptance:**
- Setup can't be finished through the API without the caller's phrase.
- `/auth/me` has `phrase_set`.
- `PUT /cloud/phrase` stores `words`, and `GET` returns `phrase_words`.
- A wrong check is 403.
- A Luna id made while Connect was off gets registered once Connect is reachable, and only once.
- The phrase status no longer has `admin_has_phrase`.

**Scenarios closed:** `dashboard/no-phrase` (the lunad side), and the server half of the setup scenarios in brief H.

**Self-check:**
- `cargo check -p lunad --tests` from `luna/`.
- Read your diff against this list. Don't run tests; the parent runs `./ci run -profile luna`.
- There's no allowed Python check, so re-read `run.py` by eye.

---

## Brief F (sonnet): web

**Owned files:**
- New in `luna/web/src/components/cloud/`: `PhraseWordsInput.jsx` (+`.test.jsx`), `PhraseWriteDown.jsx` (+test), `PhraseGate.jsx` (+test)
- New: `luna/web/src/components/setup/PhraseStep.jsx` (+test)
- Changed in `luna/web/src/components/cloud/`: `RecoveryPhraseCheck.jsx` (+test), `RecoveryPhraseCard.jsx` (+test), `PhraseReplaceFlow.jsx` (+test), `RestoreForm.jsx`
- Deleted: `luna/web/src/components/cloud/RecoveryPhraseSetup.jsx` and its test
- `luna/web/src/components/files/ProtectSheet.jsx` (+test)
- In `luna/web/src/components/settings/`: `categories/CloudBackupCategory.jsx` (+test), `settingsCategories.js` (+`settingsCategories.test.jsx`)
- `luna/web/src/pages/SetupPage.jsx` (+test), `pages/DashboardPage.jsx` (+`DashboardPage.test.jsx`, `DashboardNeedsYou.test.jsx`)
- `luna/web/src/App.jsx`
- `luna/web/src/lib/cloudPhrase.js` (+test), `lib/cloudRestore.js`
- `luna/web/src/test/dashboardHarness.jsx`
- `luna/AGENTS.md` (one line)

**Changes:**

**F1. Building blocks**
- **`lib/cloudPhrase.js`:**
  - `normalizePhraseStatus` adds `phrase_words` (12 or 24, otherwise 0) and drops `admin_has_phrase`.
  - `REFUSED_STATUSES = new Set([403])`. Any other 4xx throws Luna's message through `apiErrorMessage`.
  - `buildPhraseBody` adds `words: entropy.length === 32 ? 24 : 12`.
  - New export `splitPhraseText(text)` as described in §2.
- **`PhraseWordsInput.jsx`:** a controlled component, props `{ count, words, onChange(words), onCountChange?, lengthKnown, describedById }`. It holds every per-box state, keyboard rule, chip and paste rule from §2, and calls `haptic("selection")` when a chip is taken.
  - Also export a `WordBox` for a single box at a given position, used by the confirm step.
- **`PhraseWriteDown.jsx`:** not a modal. Props `{ surface: "secondary", onSave(entropy): Promise, saveLabel, headingLevel, intro? }`.
  - It owns making the phrase, the 12/24 switch, Print/Download/Copy (moved from `RecoveryPhraseSetup`), show → confirm with 3 `WordBox`es, shake and inline errors, and the `beforeunload` guard until `onSave` resolves.
  - Copy exactly as in §3.
- **`RecoveryPhraseCheck.jsx`:** rebuilt on `PhraseWordsInput`.
  - Props: `open`, `onClose`, `verify`, `onVerified`, `mode` (kept for compatibility), `error`, `title`, `submitLabel`, `words` (0, 12 or 24), `onLost`.
  - The in-modal "Your phrase matches" notice goes: success is always `onVerified(phrase)`.
  - All the §2 copy and error messages.
  - Words are wiped on close and on success.

**F2. Required phrase**
- **`PhraseStep.jsx`:** the setup step (§3), built on `PhraseWriteDown`. It calls `createIdentity()` on mount and gets `userId` from `useAuth`.
- **`SetupPage.jsx`:**
  - Add `STEP.PHRASE` to `STEP`, `VISIBLE_STEPS` and `STEP_ORDER`.
  - `handleAccountContinue` goes to `PHRASE`; the step's save goes to `NAME` with `phrase_set: true` and calls `refresh()`.
  - Resume rules as in §3. The signed-out check includes `PHRASE`, and `account_completed` now skips to `PHRASE`.
  - `handleFinish`: an error with `code === "needs_phrase"` sets the step to `PHRASE`.
- **`PhraseGate.jsx`:** wraps the children of `RequireAuth` in `App.jsx`.
  - If `user.phrase_set === false`, it renders a full page instead of the app: `surface-primary` page, a centered `surface-secondary` card (`max-w-md rounded-large-element`).
  - Heading `Set up your recovery phrase`; lead `Every account on this Luna has its own recovery phrase. It locks your cloud backups so only you can open them.`
  - Then `PhraseWriteDown` (`saveLabel="Save recovery phrase"`) and a ghost `Sign out` button with `surface="secondary"`.
  - On save: toast `Recovery phrase saved.`, then `refresh()`.
  - Anything other than strict `false` renders the children.

**F3. Card and placement**
- **`settingsCategories.js`:** `cloud_backup` loses `connectOnly`; `luna_connect` keeps it.
- **`CloudBackupCategory.jsx`:**
  - `RecoveryPhraseCard` stays first.
  - Get "connected" from `useConnectActive()`, not `/connect/status`; Members can't read that.
  - With Connect off, show only the card's "not linked" text. Admin: `Cloud backup needs Luna Connect. Add your device token in Settings → About → Advanced.` Member: `Cloud backup needs Luna Connect. An Admin can turn it on.`
  - With Connect off, skip the cloud-backups query and the restore cards.
- **`RecoveryPhraseCard.jsx`:**
  - Remove the not-set branch, `openSetup`, `createIdentity`, the Member line and the `RecoveryPhraseSetup` import.
  - The set line becomes `12 words · Set up on October 3, 2026 · Last checked October 10`. The length part is left out while `phrase_words` is 0.
  - The check passes `words`, `onVerified` (fires the §2 toast, then closes) and `onLost={() => setDialog({ kind: "lost" })}`.
- **`PhraseReplaceFlow.jsx`:** replace its own show and confirm screens with `PhraseWriteDown` inside its `ModalCard`. Keep the titles `Your new recovery phrase` / `Confirm your new phrase` and the `Save recovery phrase` label. Pass `words` and `onLost` through to the check step.
- **`DashboardPage.jsx`:** the check gets `words={phrase.phrase_words}`, `onVerified` (fires the same toast, then `closeCheck()`), and `onLost={() => navigate("/settings#cloud_backup")}`.
- **`ProtectSheet.jsx`:** remove `openPhraseSetup`, the `phraseSetup` state and `RecoveryPhraseSetup`. A 409 `needs_phrase` shows Luna's message inline in the sheet.

**F4. Copy and docs**
- `cloudRestore.js`: "…Set it up again in Settings → Cloud backup." stays (it's true again).
- `RestoreForm.jsx` placeholder → `Your recovery phrase, with a space between each word`.
- `luna/AGENTS.md`: "The Cloud backup and Luna Connect categories show only when `connect_active`" → "Cloud backup always shows (the recovery phrase card lives there); Luna Connect shows only when `connect_active`".

**Render tests to add or update.** Every new component gets one; the contrast check runs on whatever a test renders.
- **`PhraseWordsInput.test.jsx`:**
  - pasting `"1. abandon\n2. abandon … 12. about"` fills all 12 boxes;
  - pasting 24 words switches the count when the length is unknown, and is refused with the length line when it's known;
  - `zzzz` is invalid and gets its line;
  - `aban` highlights `abandon`, and Space takes it and moves focus;
  - Backspace in an empty box moves back;
  - ArrowDown + Enter picks a chip.
- **`RecoveryPhraseCheck.test.jsx`:**
  - the default title is `Check my phrase`;
  - `words={24}` gives 24 boxes and no switch;
  - submitting with gaps gives `Fill in word 1.` and focus there, and the button is not disabled;
  - a bad checksum shows the checksum line without calling `verify`;
  - `verify` returning false shows the refusal line and `Lost your phrase?`, and keeps the words;
  - success calls `onVerified`.
- **`PhraseWriteDown.test.jsx`:** rendered on a `surface-secondary` wrapper — show → confirm, a wrong position shakes with its line, the right words call `onSave`.
- **`PhraseStep.test.jsx`:** the identity call failing shows the message and `Try again`.
- **`PhraseGate.test.jsx`:**
  - `phrase_set: false` shows the gate;
  - `true` and `undefined` show the children.
- **`SetupPage.test.jsx`:**
  - Account → Recovery phrase → Name with `4 / 6`;
  - resuming on `phrase` with `phrase_set: true` lands on Name;
  - finishing refused with `needs_phrase` goes back to the phrase step.
- **`RecoveryPhraseCard.test.jsx`:** no "Not set up" anywhere; the length shows in the set line.
- **`CloudBackupCategory.test.jsx` and `settingsCategories.test.jsx`:** the category shows with Connect off (card plus line, no list).
- **`ProtectSheet.test.jsx`:** 409 `needs_phrase` shows inline, and no setup modal opens.
- **`PhraseReplaceFlow.test.jsx` and the dashboard tests:** updated for the changes above.

**Acceptance:**
- No screen offers "Not set up".
- Setup can't reach Name without a saved phrase.
- An account without a phrase can't reach the app.
- The check modal follows §2 exactly (copy, keyboard, haptics, toast).
- The card shows in Cloud backup with Connect off.
- No "words" for the phrase itself in any shipped string.

**Scenarios closed:** `dashboard/check-overdue`, `dashboard/no-phrase`.

**Self-check:** from `luna/web`, run `npm run typecheck` and `npm run scan:colors`, then grep the changed files for `recovery words|your words|Check my words`. Don't run vitest.

---

## Brief H: gallery harness (haiku, or fold into the sonnet brief)

**Owned files:**
- `luna/web/src/dev/fake/world.js`
- `luna/web/src/dev/fake/handlers/core.js`
- `luna/web/src/dev/fake/handlers/settings.js`
- `luna/web/src/dev/scenarios/setup.scenarios.js`
- `luna/web/src/dev/scenarios/settings.scenarios.js`
- `luna/web/src/dev/scenarios/files.scenarios.js`
- `luna/web/src/dev/scenarios/dashboard.scenarios.js`
- `luna/web/src/dev/scenarios/auth.scenarios.js`
- `luna/web/src/dev/dev.test.js` (the id in the frame-URL example only)

**Fake changes:**
- **`world.js`:** the default phrase gets `phrase_words: 12, last_checked_at: 0`.
- **`core.js`:**
  - `GET /api/v1/auth/me` returns `{ ...user, phrase_set: world.phrase.set }`.
  - `POST /api/v1/setup` with `setup_completed: true` while `!world.phrase.set` returns `fail(409, "Set up your recovery phrase before you finish setup.", "needs_phrase")`.
  - Factory reset also sets `world.phrase = { set: false, set_at: 0, luna_id: "", signing_public: "", check_due: false, last_checked_at: 0, phrase_words: 0 }`.
  - Drop `admin_has_phrase` wherever it appears.
- **`settings.js`:**
  - `PUT /api/v1/cloud/phrase` stores `phrase_words: body.words || 0` and sets `last_checked_at: 0`.
  - It sets `resealing: true` only when a phrase was already set (a replacement), never on the first save.

**Scenarios:**
- **`setup.scenarios.js`:**
  - `fresh()` seeds the phrase as not set.
  - `STEPS_CHECK` becomes "Welcome → System check → Account → Recovery phrase → Name → Done, with a step counter".
  - `refresh-mid-name` and `finish-fails` seed `phrase.set: true`.
  - Add:
    - `setup/phrase-step`: signed in, `current_step: "phrase"`.
    - `setup/phrase-refresh`: same seed; checks that a refresh shows a new phrase and the line about leaving.
    - `setup/phrase-identity-fails`: fault `POST /api/v1/cloud/identity` 409 with Luna's message.
    - `setup/phrase-save-fails`: fault `PUT /api/v1/cloud/phrase` 500; the inline error keeps the confirm step.
    - `setup/finish-without-phrase`: saved step `name`, phrase not set → resumes on the phrase step.
- **`auth.scenarios.js`:** add `auth/member-needs-phrase`: a Member signed in with the phrase not set; the gate shows, Sign out works, and saving opens the dashboard.
- **`settings.scenarios.js`:**
  - Remove `settings/phrase-not-set` and `settings/phrase-member-not-set`.
  - Change `settings/connect-off`: Cloud backup is in the sidebar with the phrase card and the "needs Luna Connect" line; Luna Connect isn't.
  - Add `settings/phrase-24-words`: the check shows 24 boxes and no switch.
- **`files.scenarios.js`:** remove `files/cloud-backup-no-phrase`.
- **`dashboard.scenarios.js`:**
  - `dashboard/check-overdue` check lines become: "Check now opens Check my phrase with 12 numbered boxes", "Pasting `abandon` ×11 + `about` fills every box", "Check closes the dialog, toasts 'Your recovery phrase is correct.' and the row clears".
  - Add `dashboard/check-paste-file`: pasting the downloaded file's numbered lines fills the boxes.
- **`dev.test.js`:** swap `settings/phrase-not-set` in the frame-URL example for `settings/phrase-check-wrong`.

Don't edit `testing/results.json`. Its notes for the removed scenarios stay as history.

**Acceptance:** every scenario seed builds, and the fake refuses finishing setup and answers `/auth/me` the same way lunad does.

**Self-check:** `npm run typecheck` from `luna/web`.

---

**Order:** L, F and H can run at the same time, because they own different files. F and H assume L's API shapes: `phrase_set`, `phrase_words`, `words`, 403 on a wrong check, 409 `needs_phrase` on finish. Then one `./ci run -profile luna`. The identity follow-up from decision A comes after you answer.

### Critical files for implementation
- `/home/plainskill/Projects/LibreServ/luna/web/src/components/cloud/RecoveryPhraseCheck.jsx`
- `/home/plainskill/Projects/LibreServ/luna/web/src/pages/SetupPage.jsx`
- `/home/plainskill/Projects/LibreServ/luna/crates/lunad/src/api/setup.rs`
- `/home/plainskill/Projects/LibreServ/luna/crates/lunad/src/api/cloud_phrase.rs`
- `/home/plainskill/Projects/LibreServ/luna/crates/lunad/src/backup/cloud/identity.rs`