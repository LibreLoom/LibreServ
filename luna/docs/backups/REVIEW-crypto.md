# Cloud backup cryptography and identity: review (2026-11-21)

Review only. No code was changed and no tests were run. Everything below comes from reading the code paths, not the plans. Line numbers are against the tree at `646748f2`.

> **Status 2026-11-22:** `39956aad` fixed C-03 (a key version is republished until Connect acknowledges it), and `d4f33955` fixed C-05 (Luna no longer reads or writes drive key copies). The rest is the review as read at `646748f2`.

Assumed direction: `luna/docs/multi-luna/plan.md` (identities never move, data is copied, Phase 0 removes drive copies of the signing key and the recovery that depends on them).

Files read:

- Rust: `luna/crates/lunad/src/backup/cloud/{crypto,keys,identity,format,private,run,ops,rewrap,store}.rs`, `vectors.json`, `fixture.json`, `api/cloud_phrase.rs`, `net/connect.rs`.
- Shared browser code: `shared/ui/lib/cloud/{backupCrypto,cloudKeys,cloudFormat,cloudPrivate}.js`.
- Browsers: `luna/web/src/lib/cloudPhrase.js`, `luna/connect/web/src/lib/{cloudUnlock,privateUnlock,cloudSource,cloudDownload}.js`.
- Connect: `luna/connect/internal/api/handlers/{storage,private_open,cloud_read}.go`, `lunasig_test.go`.

## Verdict on "signing key derivation might be broken"

**No. Derivation is not broken.** Here is what is actually true, and where the real problems are.

- Luna's signing key is **not derived from the phrase at all.** It is a random 32-byte seed from `OsRng` (`crypto.rs:398-402`, `Signer::generate`), stored as a plain BLOB in `cloud_identity.signing_seed` in `luna.db` (`identity.rs:70-71`, `db.rs:1577-1589`). Legacy copies on old drives are ignored and no longer written (`d4f33955`).
- The ML-DSA seed is `HKDF-SHA256(ikm = seed, salt = none, info = "luna-mldsa-v1")` (`crypto.rs:385-387`). `Signer::from_seed` (`crypto.rs:404-409`) is the only constructor besides `generate`, and `generate` calls it. Every load, recovery and per-run path goes through it: `identity.rs:59`, `:123`, `run.rs:442`, `cloud_backups.rs:331`. The auth key uses the same constructor (`crypto.rs:129-130`). There is no second derivation.
- Rust, browser and Connect agree. JS: `backupCrypto.js:340-342` (`mldsaKeys`, `hkdf32(seed, undefined, "luna-mldsa-v1")`). Go test helper: `lunasig_test.go:25-38`. `vectors.json` pins `signer_seed -> signer_public -> signature` (the public key contains the ML-DSA half, so a wrong seed rule would show). The JS test reproduces the signature byte for byte (`backupCrypto.test.js:47-55`), and `lunasig_test.go:93-118` has Connect accept the Rust signature.
- Signing is deterministic on all three sides: Ed25519 (`crypto.rs:427`), ML-DSA `sign_deterministic` with empty context (`crypto.rs:428-432`), JS `{ extraEntropy: false }` (`backupCrypto.js:363`).
- Verification needs both halves everywhere: Rust `crypto.rs:439-466` (`ed_ok && mldsa_ok`, fixed-size arrays), JS `backupCrypto.js:376-388` (length check, then both), Go `private_open.go:69-82` (length check, then `edOK && mlOK`). A missing half cannot pass because the lengths are fixed.

At `646748f2`, what was genuinely broken was the **plumbing around the key**: the request-signature encoding (C-01), registration and rebinding of the public key on Connect (C-02, C-04), the one-shot publish of key versions (C-03), and drive-copy adoption (C-05). C-03 and C-05 were fixed later on 2026-11-22; details follow.

## Findings

Severity: **broken** = fails or is unsafe today; **weak** = works but is fragile or leaves a gap; **mismatch** = code and plan disagree; **dead code** = no live reader or writer after the multi-Luna direction.

| ID | Severity | One line |
|---|---|---|
| C-01 | broken, dead code | `X-Luna-Sig` is sent as hex, Connect decodes base64; the "move" never works |
| C-02 | broken (plan hazard) | A Luna id is locked to its first device row forever; a replaced or re-issued token blocks all its storage |
| C-03 | broken | A shared backup key version that fails to publish is never published again |
| C-04 | broken | Signing public key is registered once per Luna id, never per account; Connect's copy can be empty or overwritten, which locks private items out of the website |
| C-05 | broken (security) | A Luna with exactly one foreign key copy on a drive silently becomes that Luna |
| C-06 | weak | Luna never checks that the three phrase-derived keys came from one phrase, or that the self-sealed key is right |
| C-07 | mismatch | Source-gone backups never start a new key version (new Admins get no copy); removal re-keys at the next run, which is safe |
| C-08 | mismatch | A removed person's sealed key copies are never deleted from Connect |
| C-09 | dead code | `users/list` is published every run and read by nobody except the restore code |
| C-10 | weak | Phase 1 "new identity on changed link" leaves phrase keys bound to the old Luna id |
| C-11 | weak | Test coverage gaps in `vectors.json` and the Go test |
| C-12 | mismatch | Recipient and scope records put user ids in clear on Connect; plan says Connect never sees them |
| C-13 | weak | Strictness of Ed25519 verification differs across Rust, JS and Go; deterministic ML-DSA |
| C-14 | weak | Seed handling: plaintext at rest, extra un-wiped copies in memory |
| C-15 | mismatch | Stale comments, doc wording and mock tests |

### C-01 `X-Luna-Sig` encoding mismatch (confirmed) — broken, and dead code

- Sender (Rust): `store.rs:432-451`. It signs `luna_id ‖ 0x00 ‖ decimal timestamp` under domain `"move"` (`store.rs:423`) and writes the signature as **lowercase hex** (`store.rs:443-448`). The signature is 3373 bytes, so the header is 6746 characters.
- Receiver (Go): `storage.go:183` does `base64.StdEncoding.DecodeString(...)` and then requires `len(sig) == lunaSigLen` (3373). A 6746-character hex string is not valid padded base64 (6746 mod 4 = 2), so it fails at decode. Even if it decoded, the length would be about 5060, not 3373. `lunaSigValid` therefore returns false for every real Luna.
- The Go test helper sends base64 (`storage_test.go:113-120`), so the tests pass while production cannot.
- Everything else lines up. I found no other prefix mismatch: the `luna-sig-v2\0` + domain + `\0` + msg bytes are identical in `crypto.rs:30,468-475`, `backupCrypto.js:22,356-359` and `private_open.go:73`. The domain `"move"` and the message `lunaID + "\x00" + ts` are identical in `store.rs:441-446` and `storage.go:196`.
- Other encodings in play, all consistent with their own peer: Luna's own API uses base64 for keys and signatures (`cloud_phrase.rs:270,601-613`), Connect's registration endpoint takes hex (`identity.rs:234-239`, `storage.go:255-259`), stored records use hex (`keys.rs:434-441`) and Connect's browser reads use base64 (`cloud_read.go:392+`, `cloudSource.js:46-49`). Nothing else I traced is inconsistent.
- Impact today: every storage request from lunad carries a 6.7 KB header and pays an ML-DSA-65 plus Ed25519 signature (`store.rs:432-451` runs on every request via `identify`) for a check that never succeeds when it is needed, and is never consulted when the device already owns the Luna (`storage.go:226-228`). On the Wyse 3040 that is wasted CPU on every list and pack call.
- Fix: delete it as Phase 0 says (`REQUEST_SIGN_DOMAIN`, `IdentifyRequest` signing, `HttpStore.signer`/`signed_by`, `lunaSigValid`, `storageSigWindow`, the takeover branch of `authorizeLuna`, the `signMove` helper). Keep only `X-Luna-Id`. Do not "fix" the encoding.

### C-02 Luna id is bound to its first device row and can never be re-bound — broken (and a Phase 0 hazard)

- `luna_ids.device_id` is written in exactly two places: first claim in `bindLuna` (`storage.go:137-139`) and the takeover branch of `authorizeLuna` (`storage.go:234`). The takeover can never succeed (C-01).
- Unlinking keeps the device row (`unbindDevice` only clears the account, name and tunnel: `device.go:166-169`), so unlinking and re-linking the **same** token keeps the same `device_id` and storage still works. The lock applies when the same Luna (database intact) ends up on a **different device row**: a token replaced or re-issued in Settings, or a token from another account. Then every storage call, **reads included**, returns 403 "belongs to another device on your account" (`storage.go:229-231`). The Luna cannot back up under its identity, cannot list, and cannot delete. The website can still read, because it goes by account (`cloud_read.go` `cloudLunaOnAccount`).
- The protect-rebuild plan's claims "binding again to the same account reattaches the backups" (§5, end) and "a Luna can move to a new device" (decisions of 2026-10-17) have therefore never been true when the device row changes (they hold only for the same token). The multi-Luna plan withdraws both, but its Phase 0 keeps "`luna_ids.device_id` must be the calling device" (§3.1, last row) and defers `last_device_id` to Phase 1. Shipping Phase 0 alone makes the lock official for anyone whose token is replaced.
- Fix: in Phase 0, either let any device linked to the same account use that account's Luna ids, or have lunad treat the 403 as "identity retired" (mint a new one and clear phrase keys, see C-10); do not leave the lock silent.

### C-03 A key version that fails to publish is never published again — fixed in `39956aad`

The review below is the code at `646748f2`. `39956aad` records whether each key version is published and republishes it until Connect acknowledges it.

- `ensure_key` (`keys.rs:272-318`) commits the new version and its reader list to the database inside `prepare` (`run.rs:381-383`) **before** anything is sent. `publish` is only `Some` when `is_new` (`run.rs:432`), and `publish_and_copy` sends the sealed copies and the signed recipient list (`run.rs:458-468`, `keys.rs:407-444`, copies first, then the list).
- If `publish_key` fails (network drop, 5xx, quota, process restart between the two steps, a crash after copy 1 of 2), the run returns an error. On the next run `ensure_key` finds `latest` with an identical saved reader list and no rotate mark and returns it (`keys.rs:286-291`), so `is_new` is false and nothing is published. Packs and snapshots then upload under a version whose sealed copies or recipient list are missing on Connect.
- Nothing else repairs it: I found no write of `keys` or `recipients` records in `check.rs`, `rewrap.rs`, `retention.rs` or `ops.rs` other than backup deletion (`ops.rs:879-887`). `reseal_user_locked` (`keys.rs:724-805`) only runs after a phrase change, and only for a queued user. The private-item path has a retry (`publish_pending_scopes`, `ops.rs:497`); the shared path does not.
- Impact: backups report "OK" yet cannot be opened on the Connect website with the right phrase (`findMyKeys` needs a verified `recipients` record and a `keys` record for the version: `cloudKeys.js:223-247`).
- Fix: record "published" per key version after `publish_key` returns, and publish whenever the latest version is not marked, not only when it was just created. Test it with a store that fails on the second `put_record`.

### C-04 Signing public key registration: once per Luna id, not per account; overwritable; empty means private items cannot open — broken

- Luna registers its public key with `ensure_registered` (`identity.rs:207-229`) and remembers success under meta `cloud_identity_registered = <luna_id>`. That meta is **never cleared** (grep shows no other reference) when the device token changes or the Luna is linked to another account.
- Connect stores the key per `(account_id, luna_id)` (`storage.go:131-148`). A new account or a re-created row starts with `signing_public = ''`.
- The website's private-item gate verifies the scope record against that stored key (`private_open.go:105-189`, `loadScopeRecord` -> `parseScopeRecord`). An empty key makes `hex.DecodeString` give zero bytes, `lunaVerify` fails on length, and every private-session open returns 403 "Enter your recovery phrase again". The phrase is right; the gate is wrong.
- `setSigningPublic` (`storage.go:253-275`) also lets the owning device overwrite the key at any time, so a stolen device token can swap it and lock owners out (or forge scope records with an attacker's `auth_public` to open sessions; ciphertext only, so a lock-out and an access-control bypass, not a confidentiality loss).
- Shared (non-private) backups are not affected, because browsers trust the self-sealed copy, not Connect's key (`cloudKeys.js:203-210`).
- A second write path exists: `PutRecord` with kind `identity`, name `public` also calls `setSigningPublic` (`storage.go:621-626`). Nothing in lunad writes that record (no `"identity"` kind in `lunad/src`), so it is dead code and only an extra way to overwrite the key.
- Fix: make Connect write `signing_public` once and refuse changes, in Phase 0 (not Phase 1), and delete the `identity/public` branch. In lunad, re-register whenever Connect's copy is empty instead of trusting a per-id flag.

### C-05 Drive-copy adoption makes one Luna become another — fixed in `d4f33955`

The review below is the code at `646748f2`. `d4f33955` removed the drive-copy functions and adoption; Luna ignores legacy copies and no longer writes its signing seed to a drive.

- `known_luna_id` (`identity.rs:150-176`): with exactly **one** candidate id found on connected adopted drives it returns that id without asking Connect (`identity.rs:154`). `load_or_create_connected` (`identity.rs:84-143`) then copies that drive's seed into this Luna's database (`identity.rs:117-126`) instead of minting.
- Consequence: a fresh Luna B that adopts a drive which carries Luna A's key copy (adopt copies only B's own identity if B has one: `drives/mod.rs:658-667`) takes A's id and A's signing seed. B can sign as A, B's users derive keys under A's id, and B registers A's public key on B's account. This is M-09 from the other side, and it is the identity-move the multi-Luna plan wants gone.
- Fix: delete it as in multi-Luna §3.1 (see the remove list); until then, adopt only when Connect also lists the id.

### C-06 Phrase setup and check prove one key, not all three — weak

- The browser derives `seal_public`, `auth_public` and `self_sealed` from one phrase (`cloudPhrase.js:357-377`), but Luna accepts them as three independent values: `set_phrase` checks `seal_public` (`cloud_phrase.rs:373`), only the length of `auth_public` (`:358`, `decode_key`), and only that `self_sealed` is non-empty (`:367-371`). It cannot open `self_sealed` (self key is phrase-derived).
- The "check my phrase" action signs a challenge with the auth key only (`cloud_phrase.rs:556-598`, `cloudPhrase.js:217-221`). It proves the user knows the phrase that made `auth_public`. It does not prove that the phrase can open `seal_public` copies, nor that `self_sealed` holds the right signing key. A client bug (stale cached `signing_public`, a half-updated body) would put a wrong key inside `self_sealed`; every browser would then reject every signature (`NO_BACKUPS`) and Luna would show a green check.
- Fix: make the check also prove the seal key (Luna seals a random challenge to `seal_public`; the browser opens it and returns it, or returns a MAC under the self key). At setup, have the browser send `SHA-256(signing_public)` next to `self_sealed` so Luna can compare it with its own key, and validate `auth_public` (valid Ed25519 point, ML-DSA length and decode).

### C-07 Source-gone backups never get a new key version; removal waits for the next run — mismatch

- Plan §5: removing someone "starts a new key version … Luna re-seals the copies. Seconds" (in code it happens at the next run, which is fine in effect), and "whoever is Admin now is on every shared backup, including ones whose source is gone".
- Code: an access change only re-saves the access list (`ops.rs:979-1000`, the comment says "Key versions change on the next run"). Demoting or deleting a user calls nothing in the cloud code (`api/users.rs` has no reference). The only immediate trigger is a phrase replacement (`run_marked`, called from `cloud_phrase.rs:519` only). Cloud runs are scheduled every six hours (`main.rs:560-580`).
- Effect on "can a removed person still open new versions?": **No.** Every upload is a run, and every run goes through `prepare` -> `ensure_key` with the live recipients (`run.rs:361-383`). A new reader set starts a version with a fresh random key and a fresh dedup key (`keys.rs:293-300`), the dedup scope id differs (`run.rs:395-396`) so no old pack is reused, and `publish_key` seals only to current recipients. So there is no six-hour exposure window: the only gap is a run already in progress when the removal happens, which finishes under the old version. The removed person keeps the latest old version's key copy and can open everything uploaded up to that point, which the plan accepts.
- For a backup whose source is gone, `run_with_root` holds the run in `source_looks_missing` (`run.rs:155-171`) before `prepare` and `ensure_key` run, so a new Admin never gets a copy and a demoted Admin never loses one. This contradicts the "Admins entry is a role" rule.
- Fix: for source-gone backups, let a run start the new key version and publish its copies without copying data. Optionally also mark and run affected backups on removal (`mark_rotate`, `run_marked`) so the old version closes sooner.

### C-08 Removed person's old sealed copies stay on Connect — mismatch

- Plan §5 says removed people's "sealed copies and share links are deleted". Code deletes `keys/…` and `recipients/…` records only when the whole backup is deleted (`ops.rs:880-887`). The key tests assert the opposite: "Bob's old copy stays for version 1 only" (`keys.rs:1111-1126`). They also stay in the re-seal set on purpose, so a removed person who later gets a phrase change does not matter. Their copies of **earlier** versions stay openable by them.
- Impact: what they could open before can still be opened, which the plan accepts. The line in the plan about deleting copies is simply wrong.
- Fix: delete the plan sentence, or implement it: delete `keys/<backup>.<version>.<part>` for every version the person is not a reader of in the newest version. (This weakens nothing; they already have the key if they downloaded it.)

### C-09 Signed user list is published every run and has no reader — dead code

- `publish_users` (`ops.rs:402-439`) writes `users/list` (all users, about 10 KB each: 2432 hex for the seal key, 3968 for the auth key, about 4000 for `self_sealed`, plus overhead) and one `self/<part>` per user, on every run. The `self` records are needed; `users/list` is not.
- Readers: only `verify_user_list` in `api/cloud_restore.rs:764-765`. Connect serves browsers only `snapshots, keys, recipients, self, pscopes, psnapshots` (`cloud_read.go:34`), so no browser ever reads `users`. After Phase 0 deletes `cloud_restore.rs`, nothing reads it.
- It is also built from `db::list_user_keys` with no join to existing users (`keys.rs:583-598`, `ops.rs:410-429`), so deleted users' keys and `self` records are republished forever (`db::delete_user_keys` has no production caller, `db.rs:1648`).
- The record also approaches Connect's 1 MB limit at roughly 90 users (`storage.go:30`).
- Fix: delete `publish_user_list`, `user_list_record`, `verify_user_list`, `ListedUser`, `USERS_*` and the write in `publish_users`; keep the per-user `self` records but only for users that still exist.

### C-10 Phrase keys are bound to the Luna id; Phase 1 can orphan them — weak (plan hazard)

- `derive(entropy, luna_id)` (`crypto.rs:117-139`) bakes the id into every key. `user_keys`, `self_sealed`, `backup_keys` reader lists and `cloud_private_scopes` all hold values bound to the id current at setup.
- Today a new id appears only when the identity row and `user_keys` are both gone (factory reset clears both: `db.rs:609-619`; database loss loses both), so setup runs again. Plan §4.2 ("A changed link means a new identity … lunad retires its local identity and mints a new one") makes a new id appear while `user_keys` still exist. After that Luna would seal key copies to public keys derived under the **old** id, and a browser that derives with the **new** id (the only id it is shown for that entry) can never open them. Same for `self_sealed` and its AAD (`cloudKeys.js:64-71`).
- Fix: when Luna mints or retires an identity, delete all `user_keys` (and scopes) in the same transaction, so every person must enter their phrase again, which is the "Use the phrase from your old Luna" flow (§6.4). That flow is sound on the crypto side: the same phrase derives different keys per Luna id, so one phrase opens both Lunas without sharing key material. The cost is the one Q4 names: one leaked phrase opens both.

### C-11 `vectors.json` coverage — weak

Does both sides read it? Yes: Rust `crypto.rs:566,730` (`include_str!`, the whole vector set is regenerated and compared), JS `backupCrypto.test.js:4` (imports the file), Go `lunasig_test.go:93-118` (reads it from disk). `fixture.json` is also read by three JS test files and by Go (`private_open_test.go:259`) for real record formats.

What the vectors cover: labels `x25519`/`mlkem` (jointly, through `seal_secret`/`seal_public`), `self`, `auth` (12-word: secret and public; 24-word: public); both phrase lengths; the signing seed -> public key -> signature; seal, encrypt, chunk id, pack id, canonical; the private-scope seal chain.

Gaps:

1. One Luna id (`luna-test-1`), not a real-format id (`luna-` plus 26 base32). Id binding is only tested in Rust (`derive_is_deterministic_and_bound_to_luna_id`, `crypto.rs:735-744`); no cross-language vector uses a second id.
2. The Go test skips silently if `vectors.json` is not mounted (`lunasig_test.go:95-98`, `t.Skipf`). Connect is a separate module, so a CI that checks it out alone passes with no coverage.
3. No shared vector for the `phrase-replace` / `phrase-check` messages. `replace_message` (`cloud_phrase.rs:308-337`) and `replaceMessage` (`cloudPhrase.js:154`) are written twice. I compared them by reading and they match today, but the JS tests only verify JS signatures against JS messages (`cloudPhrase.test.js:243-359`).
4. `recipients` signs `JSON.stringify(users)` in JS (`cloudKeys.js:126`) and `json!(users).to_string()` in Rust (`keys.rs:131`). They agree for ASCII ids; no vector exercises non-ASCII or escape characters in a user id.
5. No negative vector shared across languages (low-order X25519, ML-KEM key that fails the modulus check, truncated signature). Each language tests its own, so Go has none.
6. Rust-signed vectors only; the JS test checks equality with the Rust bytes, which covers both directions for deterministic sealing and signing. Good, and enough.

Fix: add a second vector set with a real-format id and non-ASCII user id, a `phrase-replace` message and signature, and negative cases; make the Go test fail, not skip, when `LUNA_VECTORS` is set.

### C-12 Connect sees user ids in clear — mismatch

- `recipients/<backup>.<version>` carries `{"users":[user ids…]}` unencrypted (`keys.rs:434-441`) and `pscopes` records carry `user_id` (`private_open.go:112-125`). Names are hashed in record names, but the ids are readable. Plan §5 "What Connect sees" lists only counts and opaque scope ids.
- Impact: Connect learns which Luna-internal user ids may read each backup version and when membership changed, and which id owns each private scope. Ids are opaque UUIDs, not names.
- Fix: either update the plan sentence or encrypt the recipient list to the backup key (browsers could still verify the signature over the decrypted list) and drop `user_id` from the signed scope record in favour of the hash already used in names.

### C-13 Verification strictness and deterministic ML-DSA — weak (informational)

- Rust uses `verify_strict` (`crypto.rs:450-452`), JS `zip215: false` (`backupCrypto.js:380-382`), Go `ed25519.Verify` (`private_open.go:74`). They accept slightly different encodings of small-order or non-canonical points. Because the public key is chosen by Luna and the browser trusts only the self-sealed copy, this does not matter in practice, but the three do not "agree" in the strict sense.
- ML-DSA is signed deterministically (`crypto.rs:430`, `backupCrypto.js:363`). FIPS 204 allows it and notes the hedged variant resists fault attacks; Luna's signer is not in an adversarial environment, so this is a note, not a request. The ML-DSA and ML-KEM crates are young (`ml-dsa 0.1.1`, `ml-kem 0.3.3` with `hazmat`, `@noble/post-quantum 0.7.1`); the hybrid with Ed25519/X25519 is the right hedge and the vectors catch a divergence.

### C-14 Seed handling — weak

- The seed is stored unencrypted in `luna.db` (`db.rs:1577-1589`), plus on drives (to be removed). `run.rs:353-358` re-reads the seed and `run.rs:442` / `cloud_backups.rs:331` rebuild a `Signer` from a copied `[u8; 32]` that is not wiped. `Signer::from_seed` takes the seed by value. Low impact because the process holds the signer for its whole life anyway.
- Fix: hold one `Arc<Identity>` and hand out references; do not re-read or copy the seed. Not urgent.

### C-15 Stale comments, wording and mocks — mismatch

- Plan says `info = label ‖ Luna id`; the code is `label ‖ 0x00 ‖ luna_id` (`crypto.rs:78-85`, `backupCrypto.js:74-76`). Both sides agree; update the plan (`protect-rebuild/plan.md` §5 "Recovery phrase").
- `keys.rs:35` ("Length of the Ed25519 signature"; it is 3373 bytes) and `cloud_phrase.rs:609` ("exactly 64 bytes"; it is 3373).
- `net/connect.rs:2853-2856` registers a 32-byte hex key and uses uppercase Luna ids that Connect's own pattern (`storage.go:43`, lowercase only) would refuse; the mock accepts what production would reject.

## Review items 1 to 6, answered

### Item 1. Phrase to keys

- Input is the BIP39 **entropy** (16 or 32 bytes), not the word string: `crypto.rs:117-139`, `backupCrypto.js:97-115`, entropy from `phrase_to_entropy`/`phraseToEntropy` (`crypto.rs:507-526`, `backupCrypto.js:434-452`). Words are lowercased and whitespace-split on both sides; the 4-letter prefixes are not accepted on either side.
- Salt `luna-backup-v1` (`crypto.rs:29`, `backupCrypto.js:20`). `info = label ‖ 0x00 ‖ luna_id` (UTF-8). Labels `x25519` (32 bytes, clamped), `mlkem` (64 bytes, FIPS 203 `d ‖ z`), `self` (32), `auth` (32 bytes, used as the Ed25519 seed, with the ML-DSA seed derived from it by `luna-mldsa-v1`). Identical in Rust and JS by inspection and by the vectors.
- Both seeds use HKDF from the same entropy, so the phrase strength caps everything, as the plan says.
- Nothing is stretched. That is correct for generated 128 or 256-bit entropy. It would be wrong for any user-chosen phrase; nothing in setup accepts one (`newEntropy` is `crypto.getRandomValues`), but the "use the phrase from your old Luna" flow takes a typed phrase, which was generated, so it is fine.
- Coverage: see C-11.

### Item 2. Luna's signing key

- Generation, storage, derivation, determinism, verification: see the verdict above.
- Encoding and prefix mismatches: only C-01. Connect also stores `signing_public` as lowercase hex (`storage.go:255-259`) and Luna sends hex (`identity.rs:234-239`): consistent.
- Connect verifies both halves for private-scope records and private opens (`private_open.go:69-82`, `:145-160`, `:243`). It does **not** verify anything else Luna signs (snapshots, key copies, recipient lists); browsers do (`cloudFormat.js:100-125`, `cloudKeys.js:114-182`). That is the intended split.

### Item 3. Sealing

- X25519 + ML-KEM-768, HKDF-SHA256 over `shared_x ‖ shared_k` with no salt, info `luna-seal-v2 ‖ eph_public ‖ recipient_x ‖ mlkem_ct ‖ SHA-256(recipient_mlkem_public)`, then XChaCha20-Poly1305. Rust `crypto.rs:231-265`, `:316-334`; JS `backupCrypto.js:164-175`, `:236-247`. Combiner order, info strings, layout (`eph 32 ‖ ct 1088 ‖ nonce 24 ‖ body+tag`) and nonce handling (random 24 bytes carried in the output) are identical. Associated data goes to the AEAD only (not the KDF) on both sides.
- Both secrets are needed: the key mixes both shared secrets, and the tests `a_copy_needs_both_secrets_to_open` (`crypto.rs:791-803`) and the JS equivalent (`backupCrypto.test.js:151`) check it.
- Recipient checks match: low-order X25519 point and ML-KEM modulus check on seal (`crypto.rs:214-226`, `backupCrypto.js:~180-205`).
- No issue found. Nonces are random 192-bit under per-seal ephemeral keys (and random under long-lived keys for `encrypt`), so reuse is not a concern.
- Not bound to the Luna id in the AAD: the pack key wrap, pack index/body and tree/meta AADs are constants (`format.rs:30-36`, `cloudFormat.js:20-24`). They are protected by the key, which is per backup version and sealed under id-bound AAD, so a pack moved to another Luna id is unreadable without the key. Worth knowing for the copy design: packs themselves are portable, keys are not.

### Item 4. Identity binding: where the Luna id enters, and what a different id would do

- **Derivation:** every phrase key (`crypto.rs:79-85`).
- **Signed bytes:** snapshot record (`format.rs:367-378`), recipients (`keys.rs:121-133`), key copies via AAD (`keys.rs:106-118`), `self` record AAD (`cloudKeys.js:64-71`), scope record (`private_open.go:140-153`), private seals (`private.rs:31-37`), private-open message (`cloudPrivate.js:245-251`), the unused user list and move signature.
- **Not bound:** `phrase-check` and `phrase-replace` sign only the Luna-issued random challenge (plus new keys for replace); a replay across Lunas needs the same 32 random bytes in a 5-minute window.
- **Opened on a different id:** the browser derives different keys, so AEAD fails and nothing opens (fails closed, no leak). Signed records copied between Lunas fail verification. The one way to leak is C-05: two Lunas sharing one seed and id.
- Luna holds all shared `backup_keys` in plaintext in its database (`keys.rs:301-307`, `ops.rs:895-901`). That is by design (Luna can restore for Admins) and matters only if the database leaks.

### Item 4 (continued). Identity paths that still move or rebuild an identity, for removal in Phase 0

The plan's list (§3.1, §12) matches the code. Additions and corrections:

Lunad:
- `identity.rs`: `load_or_create_connected`, `known_luna_id`, `drive_luna_ids`, `find_drive_copy`, `copy_to_drive`, `copy_to_drive_at`, `copy_to_drives`, `connected_roots`, `AMBIGUOUS_MSG`, `NO_KEY_MSG`. `load_or_create` (no network) is used only by tests outside this file; fold it into `load_or_mint`.
- `drives/mod.rs:658-667`, `drives/format/run.rs:470-476` (the two copy sites); `drive_db.rs:609-613` plus the scrub on open.
- `store.rs:422-451` request signing, `HttpStore.signer`, `signed_by` (`store.rs:553`), `api/cloud_backups.rs:330-332` (builds the signer for it).
- `net/connect.rs:1074+` `list_luna_ids`, `ConnectLunaId`, `luna_ids_unreadable`, and their tests.
- `api/cloud_restore.rs`, `api/cloud_restore_private.rs`, `backup/cloud/recover.rs`, `backup/cloud/private_recover.rs`, the two `.merge` lines at `api/mod.rs:46-47`, and the `RELINK_PENDING_*` metas (`cloud_restore.rs:49-51`).
- **Not on the plan's list but now dead:** `users/list` publication and `verify_user_list` (C-09), `keys::USERS_KIND/USERS_LIST_NAME/USERS_DOMAIN`, `ListedUser`.
- **Keep, do not delete:** `ensure_registered` / `register_public` (the registration of the public key, which Phase 0 still needs), but fix it (C-04).

Browser:
- `luna/web/src/lib/cloudRestore.js`, `privateRestore.js`, `CloudRestoreCard.jsx`, `PrivateRestoreCard.jsx`, `RestoreForm.jsx`.
- In `shared/ui/lib/cloud/cloudKeys.js`: the `expectSigningPublic` option and `SIGNING_MISMATCH` (`:173,211-214`) are used only by the Luna-side restore. The multi-key `signingPublics` list can shrink to one key after the user-list rotation story is gone; it does no harm to keep.

Connect:
- `lunaSigValid`, `storageSigWindow`, the takeover branch of `authorizeLuna` (`storage.go:178-243`), `ListLunaIDs` and `GET /storage/luna-ids` (`server.go:154`), `has_signing_key` flag.
- The `identity/public` branch in `PutRecord` (`storage.go:621-626`) and its constants (`storage.go:31-32`): dead, and a second way to overwrite the key (C-04).
- **Keep** `POST /storage/luna-ids/{id}/signing-public` (`server.go:155`) and make it write-once (C-04).

Docs: `protect-rebuild/plan.md` §5 ("Luna id", "Luna loses its database", "binding again…reattaches", "Signing key is made only once … every drive scanned"), its decisions of 2026-10-17 (identity line).

### Item 5. Phrase check, replace, rewrap and key versions (recovery-phrase plan §4)

What works as described (read in code):
- Replace proof: the old auth key signs challenge plus every new value (`cloud_phrase.rs:308-337`), under a separate domain `phrase-replace`; challenge is single use and expires in 5 minutes (`:69-73`); password proof goes through the sign-in limiter (`:421-426`) and `verify_password_for_user`. The plan's "no lockout" note is fixed.
- Not exposed: `replace_reader` swaps the public key inside the saved reader lists in the same transaction (`keys.rs:323-355`, `cloud_phrase.rs:479`), so `ensure_key` sees no change and starts no version; `queue_reseal` re-signs and overwrites every copy under the same name (`keys.rs:724-805`).
- Exposed: `mark_rotate` makes the next `ensure_key` start version N+1 and keep the dedup key only if the same people are readers (`keys.rs:293-300`). Readers open each pack with whichever version key opens it (`cloudFormat.js:468-492`, `cloudDownload.js:17-26`), and `rewrap.rs` moves old packs on the trickle.
- Removed person and new versions: see C-07. Fresh random key plus fresh dedup key, separate dedup scope, sealed only to current recipients: a removed person cannot open anything uploaded after the next run. Connect's B2 buckets now keep only the last version (`providers/b2.go:125-139,221`), so "replaced" is true.

What does not work as described:
- C-03 (publish not retried), C-06 (check proves only auth key), C-07 (source-gone backups), C-08 (copies not deleted).
- `set_phrase` for a first phrase has no proof by design (`cloud_phrase.rs:382`); anyone with a live session can set the first phrase for that user. The plan accepts this.
- `check` has no per-attempt limit but needs a valid ML-DSA+Ed25519 signature over a fresh challenge, so guessing is not feasible. Fine.

### Item 6. What would make a backup unrecoverable on the Connect website with the right phrase

1. C-03: key copies or recipient list never published for a version.
2. C-04: Connect's stored signing public key is empty, stale or overwritten; private items return 403.
3. C-06: a wrong or missing `self_sealed`/`self` record. `findMyKeys` needs a candidate user id from a recipient or scope record **and** the matching `self/<part>` record (`cloudKeys.js:184-210`); if `publish_users` keeps failing (`ops.rs:348-354`, reported as a run problem) nothing opens. After a user is deleted and recreated their id changes, so their old self record is under the old hash; the new person's phrase finds it only through the old id in the recipient list, which still works.
4. C-02: nothing on the website, but a Luna on a replaced or re-issued token cannot upload or reach its own storage, so new data stops arriving.
5. Wrong Luna id: the browser must derive with the id the backups were sealed under. After a reset or a new identity the old id is a different entry in `LunaPicker` and the error "doesn't open any backups on this Luna. Check each word." (`cloudKeys.js:10`) blames the words. Say which Luna id was used.
6. C-10 in a future Phase 1: keys bound to a retired id.

## Remove list (Phase 0)

Everything in "Identity paths" above, plus these safety changes that belong in the same phase:

1. Delete drive-copy adoption (C-05) and the drive copy writes.
2. Delete request signing and the takeover (C-01); decide the re-link rule (C-02).
3. Make `signing_public` write-once on Connect and have lunad re-register when it changes (C-04).
4. Stop publishing `users/list` (C-09).

## Prioritised list

1. **C-03** Publish key versions until they are confirmed (broken; data silently unrecoverable on the website).
2. **C-05** Remove drive-copy adoption (a Luna can become another Luna).
3. **C-02** Decide what happens when a Luna lands on a different device row (replaced or re-issued token), before shipping Phase 0; otherwise its storage is locked permanently.
4. **C-04** Make Connect's signing key write-once, delete the `identity/public` branch, and re-register when Connect's copy is empty.
5. **C-01** Delete request signing (do not repair the encoding); saves a 6.7 KB header and two signatures per request.
6. **C-07** Let source-gone backups start a new key version (new Admins get no copy today); optionally re-key sooner on removal.
7. **C-06** Make the phrase check prove the seal key and the self-sealed key; validate `auth_public`.
8. **C-10** Clear phrase keys whenever a new identity is minted (before Phase 1).
9. **C-09** Stop publishing `users/list`; only publish `self` records for existing users.
10. **C-11** Extend `vectors.json` (real-format id, non-ASCII user id, replace message, negative cases) and make the Go test fail instead of skip.
11. **C-08, C-12, C-13, C-14, C-15** Align the plan with the code, tidy comments and mocks, and hold one `Identity` instead of copying seeds.
