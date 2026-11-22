# Multi-Luna accounts — plan for review (2026-11-21)

**Scope decision (2026-11-21).** Cloud downloads stay on the Luna Connect website. The replacement, migration, and Bring back files flows below are deferred design notes. The next Multi-Luna implementation covers independent Lunas under one account. See the [backup spec](../backups/SPEC.md) for the current restore rules.

Phase 0 is partly built as of 2026-11-22: `d4f33955` stopped writing drive key copies and ignores legacy ones, and `39956aad` retries key publication. The rest of this plan is not built; section 1 is the audit as written on 2026-11-21. This plan answers audit finding M-09 (adopting a drive copies Luna's cloud signing key onto it). It follows the user's direction of 2026-11-20: drop drive identity rebuild entirely. Instead, a Luna Connect account holds many Lunas, and each Luna has its own identity, address, storage and payment. Moving to a replacement Luna means copying data from one Luna to another, never handing one Luna's identity to another.

Audit findings are referred to by ID only (M-09, Chain 1, Chain 4, H-01a, H-01c, H-06, M-22, M-23). The audit report itself stays private.

## 1. What's true today

### Lunad: the signing key lives on every drive

- **Adopting a drive writes the raw signing seed into the drive's own SQLite file.** `drives/mod.rs:658-667` calls `identity::copy_to_drive_at` after every successful adopt, with no check on whose drive it is. `copy_to_drive` (`backup/cloud/identity.rs:250-257`) inserts `identity.signer.seed()` into `cloud_signing_keys`. That table is created in every drive DB (`drives/drive_db.rs:609-613`) and stored in plain text at the drive root. The module's own comment says "the secret half never leaves this process" (`identity.rs:22`), and that stopped being true after the first adopt.
- **The same copy is written in two more places:** on reformat (`drives/format/run.rs:470-476`), and to every connected drive when an identity is first minted (`load_or_create`, `identity.rs:64-75`; `load_or_create_connected`, `identity.rs:138-140`).
- **The only reader is the database-loss recovery.** `load_or_create_connected` (`identity.rs:84-143`) runs when the system DB has no identity. It lists the Luna ids that have key copies on connected drives (`drive_luna_ids`), narrows them with Connect's per-account list (`known_luna_id` → `ConnectService::list_luna_ids`, `net/connect.rs:981`), and takes the seed back with `find_drive_copy`. Callers are phrase setup (`api/cloud_phrase.rs:280`), backup creation (`api/cloud_backups.rs:323`) and the run path (`backup/cloud/ops.rs:138`, `:409`).
- **A recovered identity feeds the index rebuild.** `api/cloud_restore.rs` (`GET/POST /api/v1/cloud/restore`) and `backup/cloud/recover.rs` rebuild the shared snapshot index from Connect records, checked against the recovered signing key. `api/cloud_restore_private.rs` and `backup/cloud/private_recover.rs` do the same for private items. In the web UI they are `CloudRestoreCard.jsx`, `PrivateRestoreCard.jsx`, `lib/cloudRestore.js` and `lib/privateRestore.js`. H-06 (the browser-supplied `source_drive`/`source_path` in the private restore) lives in this code and only becomes reachable through the database-loss path.
- **Factory reset leaves the copies on the drives.** `db::factory_reset` (`db.rs:594`) clears the system tables, but the per-drive `.luna-*.sqlite3` files stay on the drives with their `cloud_signing_keys` rows.
- **`manifest.luna_id` is written but never read.** `drive_backup.rs:459-471` and `:747-748` stamp the Luna id into each drive-backup manifest. A repo-wide search finds no reader.

### Lunad ↔ Connect: a "move" signature that never worked

- Luna signs every storage request with the signing key, using domain `"move"` (`backup/cloud/store.rs:422-450`). The point was to let a rebuilt Luna on a new device token take over its old storage.
- Connect checks that signature in `lunaSigValid` (`connect/internal/api/handlers/storage.go:178-201`). If it verifies, `authorizeLuna` (`:203-243`) rebinds `luna_ids.device_id` to the caller.
- The two sides disagree on the encoding. Luna sends `X-Luna-Sig` as **hex** (`store.rs:443-448`), but Connect decodes it as **base64** and requires `lunaSigLen` bytes (`storage.go:183-186`). The test helper also sends base64 (`storage_test.go:113-120`). A real Luna's move therefore always fails. That is one more sign that this path is safe to delete.

### Connect: one Luna per account, with billing on the account

| Concern | Where it is per account today |
|---|---|
| Device cap | `MaxDevicesPerAccount = 1` (`handlers/context.go:26`). `Bind` refuses a second one with "This account already has a Luna. Unbind it first…" (`device.go:60-64`). The count and the later `claimDevice` are separate statements. |
| Onboarding state | `accounts.onboarding_path` / `onboarding_step` (`database/schema.go:16-17`). `loadBoundDevice` reads `… WHERE account_id = ? LIMIT 1` (`onboarding_state.go:17-29`). `ResolveOnboarding` assumes that single device. |
| Billing | `accounts.stripe_customer_id`, `stripe_subscription_id`, `has_card`, `billing_status`, `backup_quota_bytes`, `backup_purge_after`. `claimSubscription` (`checkout.go`) allows only one subscription per account, because "usage is reported per Stripe customer, so a second one would bill the same storage twice". |
| Card check | `oss_payments` has `account_id` as its primary key. `markCardChecked` upserts on account and `humanVerified` reads it. `MintDIY` (`onboarding.go`) mints any number of DIY tokens (5 per hour, `allowGuess "diy-mint:"`) after one $1 check. |
| Credit | Stripe billing credit grants on the account's customer (`billing/credits.go` `GrantCreditBy`, scope `metered`). The $1 is granted as `category=paid` with idempotency key `luna-card-check-<session>`. |
| Usage | `SampleStorage`, `loadPeriodUsage`, `AccountPeriodUsage`, `RecordEgress` (`billing/usage.go`) and `billing_storage_samples` / `billing_period_egress` are all keyed by `account_id`. Meter events carry `stripe_customer_id`. |
| Quota and lock | `storageUsed`, `accountBackupCap`, `backupUnlocked` (`storage.go:301`, `:1059-1079`). `storageScope` locks the account row for every PUT. |
| Retention | `ProcessRetention`, `scheduleBackupPurge`, `deleteCloudCopiesNow` and `purgeAccountBackups` (`retention.go`) all purge **the whole account's storage**. |
| Device status | `Status` (`device.go:214-313`) answers `backup_unlocked` from the account's billing. |

Storage is already partly per Luna. `storage_packs`, `storage_records` and `luna_ids` are keyed by `(account_id, luna_id)`, and `bindLuna` caps an account at 25 cloud identities (`storage.go:35`, `:132-152`). The Connect web Backups page already has a `LunaPicker` (`BackupsPage.jsx:123`) for several `luna_id`s.

### Onboarding today

- **Connect web** (`connect/web/src/pages/OnboardingPage.jsx`). Official path (`/onboarding`): `welcome → account (+verify) → code → domain → backup → done`, with a front-end-only `plug-in` step. DIY path (`/diyonboarding`, `/register`): `account → card → diy-code → domain → backup → done`. Server-stored `onboarding_step` values are `verify`, `code`, `bind`, `diy-code`, `oss-code`, `domain` (legacy `name`), `backup` (legacy `copies`) and `done`. A signed-in account with a bound device sets `skip_code_entry` and resumes at that one device, so an existing account cannot add a second Luna through this flow.
- **Account home** (`LunaPage.jsx`) is titled "Devices", but it shows one card, "My Luna", described as "One Luna on this account" (`devices[0]`).
- **Luna setup wizard** (`luna/web/src/pages/SetupPage.jsx`): `welcome → preflight → account → name → done`. A `?token=` link from Connect prefills the device token and hides that substep. Off-LAN, registering the first account needs that token (`first_user_device_token`, `api/auth.rs`).
- **Printed quick-start card** sends people to `connect.luna.libreloom.org/onboarding` (`quick-start/src/App.jsx:77`). That route is a public path and must stay.

### Companion apps

Desktop (`desktop/src/session.rs` `SessionData { base_url, username, token }`) and Android (`BackupPrefs.kt`: `base_url`, `token`, `username`, `drive_id`) each talk to one Luna by its address. Neither knows about Connect accounts, and neither pins anything that identifies the Luna behind the address.

## 2. Principles

1. **One Luna, one of everything.** In Connect, every Luna has its own cloud identity, address, tunnel, storage, quota, subscription, credit and retention countdown. Nothing is shared between two Lunas except the account that owns them.
2. **Identity never moves.** A cloud identity (`luna_id` + signing key) belongs to the Connect Luna entry it was first registered with, for its whole life. No drive, no signature and no support action hands it to another device or entry.
3. **The recovery phrase is the security boundary for old data.** Getting data from a dead Luna onto a new one needs that person's recovery phrase, opened in their own browser. Connect permissions only decide who may fetch the ciphertext.
4. **Copy, don't adopt.** A replacement Luna downloads files and writes them to its own drives, then backs them up again under its own identity. Old history stays readable on Connect for as long as the old Luna's entry is kept.

## 3. Removing drive identity rebuild

### 3.1 What goes

| Code | Change |
|---|---|
| `drives/mod.rs:658-667` | Delete the adopt-time copy. |
| `drives/format/run.rs:470-476` | Delete the reformat-time copy. |
| `identity.rs` `copy_to_drive`, `copy_to_drive_at`, `copy_to_drives`, `find_drive_copy`, `drive_luna_ids`, `known_luna_id`, `connected_roots`, `AMBIGUOUS_MSG`, `NO_KEY_MSG` | Delete. |
| `identity.rs` `load_or_create_connected` | Shrink to `load_or_create` followed by `ensure_registered`. Neither the drives nor Connect's id list are consulted any more. Rename it `load_or_mint`. |
| `drive_db.rs:609-613` `cloud_signing_keys` | Remove from the schema, and add the scrub described in §3.2. |
| `net/connect.rs:981` `list_luna_ids`, `ConnectLunaId`, `luna_ids_unreadable` | Delete. |
| `store.rs:422-450` request signing (`REQUEST_SIGN_DOMAIN`, the `X-Luna-Ts`/`X-Luna-Sig` headers) | Delete. Keep `X-Luna-Id`. |
| `api/cloud_restore.rs` (with its `RELINK_PENDING_META` / `RELINK_PENDING_IDS_META` metas), `backup/cloud/recover.rs`, `api/cloud_restore_private.rs`, `backup/cloud/private_recover.rs`, and their `.merge(...)` lines in `api/mod.rs:46-47` | Delete. Each rebuilds an index under a recovered identity, and a Luna can no longer recover one. The H-06 code goes with them. |
| `web/src/components/cloud/CloudRestoreCard.jsx`, `PrivateRestoreCard.jsx`, `RestoreForm.jsx` (if nothing else uses it), `lib/cloudRestore.js`, `lib/privateRestore.js` and their tests | Delete. §7 adds a replacement. |
| `manifest.luna_id` (`drive_store.rs:44`, `drive_backup.rs:459-471`, `:747-748`) | Delete. Nobody reads it, and it suggests a link between drives and the cloud identity that no longer exists. |
| Connect `storage.go` `lunaSigValid`, the takeover branch of `authorizeLuna`, `storageSigWindow`; route `GET /storage/luna-ids` and `ListLunaIDs` | Delete. In phase 0, `authorizeLuna` keeps only today's ownership check (`luna_ids.device_id` must be the calling device, and a new `luna_id` binds to the caller through `bindLuna`), so a request with another device's `luna_id` gets 403. Phase 1 replaces that check with the entry-based rule in §4.2. |

### 3.2 Scrubbing seeds already on drives

Dropping the table is not enough, because SQLite leaves the deleted bytes in freed pages. When `drive_db::open` sees a `cloud_signing_keys` table, it should run `PRAGMA secure_delete = ON; DROP TABLE cloud_signing_keys; VACUUM;`. The legacy `DROP TABLE IF EXISTS album_members…` block at `drive_db.rs:621` is the precedent for where this goes. This deletes a secret rather than preserving data, so the "no migrations" rule does not exempt it. It only cleans drives that a current Luna mounts again. A stick that never comes back keeps its copy. After phase 0 that leftover seed is worth little: Connect authorizes storage only by device token, never by signature, so the seed alone reaches nothing on Connect. It cannot read backups either, because they are encrypted to phrase-derived keys, not to the signing key. Forging signed records with it would also need the device token, and browsers would still notice a swapped key because they check against their self-sealed copy. Phase 1 adds one more step: deleting a Luna's cloud backup retires the identity on Connect, so even a token-holding attacker cannot upload under it.

### 3.3 How cloud backup works afterwards

- **Minting:** a Luna mints its `luna_id` and signing key once (phrase setup, or the first cloud backup) and registers them with Connect under its own Luna entry. The signing key exists only in the system DB.
- **Losing the system DB** (same hardware, drives intact, H-01c-style damage or a deliberate factory reset) gives a fresh identity on the next cloud setup. Connect keeps the old identity under the **same Luna entry**, listed as "Backups from before <date>". The drives still hold the files, so the new identity uploads them again. Drive backups come back from each drive's manifest, paused until the owner or an Admin taps Resume (M-23). Once the new backup has finished, the Luna's Cloud backup page offers to delete the old one (§8.1 step 5).
- **A dead Luna:** the person sets up a new Luna on the same account (§6.3) and brings the files across with the import (§7). Their recovery phrase opens the old Luna's backups in their own browser, exactly as Connect web's Backups page does today.
- **Without any new Luna:** Connect web's Backups page still downloads files and folders with the recovery phrase, per Luna entry. That is the fallback during the phases before the import ships.

The 2026-10-17 identity decision ("candidates come from drive key copies; Connect's luna-ids list only breaks ties… Luna can move to a new device") is withdrawn. So is protect-rebuild §5's "Luna loses its database" procedure (steps 1-2), and so are its sentences about signing-key copies on drives and "binding again to the same account reattaches the backups". The end of §11 lists the documents to update.

## 4. Data model in Connect

### 4.1 Entities

The core change is a new `lunas` table. It separates **the Luna on an account** from **the device token** (which belongs to the hardware) and from **the cloud identity** (which belongs to one Luna entry).

```
accounts           id, email, password_hash, email_verified, created_at
                   (billing, quota, onboarding and purge columns move to lunas)
devices            id, code_hash, code_hint, code_sealed, kind ('official'|'diy'),
                   revoked, local_port, last_seen_at, order_ref, created_at
                   (account_id, name, subdomain, tunnel_* move to lunas)
lunas              id ('lun_…'), account_id NOT NULL, device_id UNIQUE NULL,
                   last_device_id, name, subdomain UNIQUE, tunnel_id, tunnel_token,
                   setup_step, setup_kind, replaces_luna_id NULL,
                   stripe_customer_id, stripe_subscription_id, billing_status,
                   backup_quota_bytes, backup_purge_after, purge_mail_day,
                   created_at, removed_at
cloud_identities   luna_id PK (lunad-minted), luna_ref → lunas.id, signing_public
                   (immutable once set), retired_at, created_at
card_checks        checkout_session_id PK, account_id, luna_ref, payment_intent_id,
                   status, created_at
luna_read_grants   id, account_id, source_luna_ref, target_luna_ref, target_device_id,
                   created_at, expires_at, revoked_at, used_at
luna_events        id, account_id, luna_ref, kind, detail, ip, created_at
storage_packs / storage_records / storage_pending_deletes / storage_record_versions
                   keyed by luna_id (cloud identity); account_id dropped from the key
billing_storage_samples / billing_period_egress
                   keyed by luna_ref
share_links, private_challenges, private_sessions
                   unchanged, scoped by luna_id
```

Notes on the shape:

- **`lunas.device_id` is nullable and unique.** A Luna entry outlives the device link. When the device is unlinked, the entry stays with its backups and subscription, shown as "Not linked". If the same device token is linked to the same account again, it reattaches to the entry whose `last_device_id` matches. If it is linked to a different account (a Luna that was sold or given away), that account gets a new entry, and the old account keeps the old entry's backups.
- **`cloud_identities.luna_id` is a global primary key.** Lunad mints 128 random bits, so collisions don't happen. A global key means a `luna_id` can never be registered twice under different entries. `retired_at` is set when the Luna on that entry mints a newer identity (after a reset), so the UI can say "Backups from before <date>".
- **`signing_public` is set once and never changed.** Today `setSigningPublic` (`storage.go:255-285`) lets the owner device overwrite it. A stolen device token must not be able to swap the key that `private_open.go` verifies scope records with.
- **The device cap goes, but an abuse cap stays.** `MaxDevicesPerAccount` becomes a cap on **Luna entries** per account (25, the number `maxLunasPerAccount` already uses; see open question Q7). It is enforced in the same statement that claims the device, in the `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < ?` style `bindLuna` uses, so two parallel binds cannot both pass.

### 4.2 Per-Luna identity, address and tunnel

- **Registration:** when lunad mints an identity, it calls `POST /api/v1/storage/identity` with the `luna_id` and signing public key. Connect inserts the `cloud_identities` row under the calling device's linked entry, and refuses if the `luna_id` already exists anywhere. The response returns `luna_ref`, which lunad stores beside its identity (`cloud_identity.luna_ref`).
- **Storage access:** `storageScope` resolves `device → lunas.device_id → luna_ref`. It then requires `cloud_identities.luna_ref = luna_ref` for the `X-Luna-Id` in the request. A PUT is allowed only for the entry's single non-retired identity. GET and DELETE are allowed for its retired identities too, which covers the "Backups from before <date>" import and cleanup. Any other `luna_id` gets 403, except reads covered by a read grant (§7.2).
- **A changed link means a new identity.** `Status` returns `luna_ref`. If lunad's stored `luna_ref` differs (the token was moved to another account, or Settings → About → Advanced replaced the token with one belonging to another entry), lunad retires its local identity and mints a new one on the next cloud setup. The old identity stays with its old entry.
- **Address and tunnel** move from `devices` to `lunas`. `applyDeviceDomain`, `regenerateDeviceTunnel` and `syncDeviceLocalPort` (`domain_ops.go`) take a `luna_ref`. `Status` and `Domain` look the entry up through `lunas.device_id`. Unlinking (`unbindDevice`) tears down the tunnel and DNS record and clears `subdomain` and `tunnel_*` on the entry, as it does today on the device row.

### 4.3 Per-Luna storage and quota

| Today (per account) | Becomes (per Luna entry) |
|---|---|
| `storageUsed(accountID)` | `storageUsed(lunaRef)`: the sum over every identity of the entry, including retired ones, because the same subscription pays for them. |
| `accountBackupCap` / `accounts.backup_quota_bytes` | `lunaBackupCap(lunaRef)` / `lunas.backup_quota_bytes`, with the same config default. |
| `LockStorageAccount(Write)` in `storageScope` | Lock the `lunas` row, so two Lunas on one account no longer serialize each other's uploads. |
| `backupUnlocked(accountID)`; `Status.backup_unlocked` | Read from the entry's `billing_status`. |
| `SampleStorage`, `loadPeriodUsage`, `AccountPeriodUsage`, `RecordEgress` | Keyed by `luna_ref`. Egress from share links and account reads is charged to the entry that owns the `luna_id`. |
| `ProcessRetention`, `scheduleBackupPurge`, `purgeAccountBackups` | One countdown per entry. The mails name the Luna, e.g. "Cloud backups for `kitchen` will be deleted in 7 days". |
| `deleteCloudCopiesNow(accountID)` | `deleteLunaCopiesNow(lunaRef)`. As written today it purges **every** Luna's storage, so leaving it unchanged would wipe all backups when one Luna's payment is turned off. |
| `accounts.PurgeStorage(accountID)` | Used only by account deletion. Everything else calls `PurgeLunaStorage` for each identity of an entry. |
| `Me` (stored bytes, estimate, credit, purge date, onboarding) | `Me` returns account fields only. A new `GET /api/v1/lunas` returns, per entry: name, address, online, kind, setup step, billing status, stored bytes, month estimate, credit, purge date and identities. |
| `estimatedMonthlyRevenue` (`admin_console.go:46`), `listAccountDevices`, `AddAccountCredit` | Sum over entries; list entries; credit goes to one chosen entry. |
| `deleteCustomerAccount` (`purge.go:94`) | For each entry: final charge, then unlink the device (the token stays with the hardware), then purge. Finally delete the account. |

## 5. Billing

### 5.1 Stripe object model

Meter events are attributed to a Stripe **customer**, and every subscription item on that customer whose price uses the meter bills the same total. The comment on `claimSubscription` already records this. One customer can therefore never carry two cloud-backup subscriptions. There are three ways to give each Luna its own subscription:

| Option | Verdict |
|---|---|
| **A. One Stripe customer per Luna entry** (email = account email, `name` = the Luna's name, metadata `account_id`, `luna_ref`). Meter events carry that customer's id. | **Recommended.** Today's meters and prices work unchanged. Each Luna gets its own invoices, Link purchase and credit balance. |
| B. One customer, separate meters per Luna | Rejected. A meter is a global object named by `event_name`, so this would mean one meter per Luna. |
| C. One customer, one subscription carrying every Luna | Rejected. It is not what was asked for, and one failed payment would stop every Luna's backup. |

Stripe objects under option A:

- **Products and prices.** "Luna cloud backup storage" ($0.008/GB-month, metered on `luna_backup_gb`, `tax_behavior=exclusive`, tax code `txcd_10010001`) and "Luna cloud backup downloads" ($0.01/GB over the free allowance, on `luna_egress_gb`) stay as they are. That is because the meters work unchanged, not to preserve old prices. Add a real product and price for **"DIY Luna activation"**: $1 plus tax, one-time, same tax code, described as "Counts toward this Luna's cloud backup." This replaces the inline `price_data` in `StartCardCheck`, so revenue reports can tell activations apart.
- **Customer:** created when the Luna entry is created (retail: at token bind; DIY: before the $1 checkout).
- **Subscription:** created through a Managed Payments Checkout in `mode=subscription`, as today. `subscription_data.metadata` = `{luna_kind: backup, account_id, luna_ref}`. If Managed Payments allows it, also set `subscription_data.description` = "Cloud backup for <name>" so the Link app can tell two Lunas apart (gate G3). The billing anchor stays at the 1st of the month UTC, with `proration_behavior=none`.
- **Credit grants:** the DIY $1 is a `category=paid` grant on the new Luna's customer, with idempotency key `luna-card-check-<session>`. Staff goodwill credit is a `category=promotional` grant on the Luna the staff member picks.
- **Webhooks:** `cancelSubscription`, `lockSubscription`, `unlockFromEvent` and `fulfillCheckout` look the subscription up on `lunas.stripe_subscription_id` instead of `accounts`. `fulfillCheckout` checks that `metadata.luna_ref` belongs to `metadata.account_id` and that the session's customer is that entry's customer. Otherwise it ignores the event, the same way it ignores a mismatched customer today.

### 5.2 Gate (do first, in the sandbox, like Step 1 of `connect/docs/billing-managed-payments.md`)

- **G1:** two customers with the same email. After a Managed Payments checkout on the first, does the second's subscription Checkout offer the saved card in one click, through Link or `saved_payment_method_options`? If not, the second Luna asks for the card again. That is acceptable, but the onboarding copy must not promise one click.
- **G2:** a credit grant on customer 2 applies only to customer 2's invoice, and the final invoice of a `cancel_at` subscription still uses it.
- **G3:** how two subscriptions on two customers with one email appear in the Link app and on receipts, and whether a per-subscription description shows.
- **G4:** cancelling one Luna's subscription through Link fires `customer.subscription.deleted` for that subscription only.

If G1-G4 fail in a way that breaks option A, stop and bring it back to the user. Don't fall back to C quietly.

### 5.3 The $1 for each DIY Luna

This overrides a recorded decision. The billing handoff says "keep the $1 card check exactly as it is" (a once-per-account human check, `oss_payments`, `human_verified`). The user's new rule is: **adding a DIY Luna always costs $1 plus tax, added to that Luna's credit.**

- `oss_payments` and `human_verified` go. `card_checks` is keyed by the Checkout session id, so the return page and the webhook, arriving in either order or more than once, still create exactly one Luna entry, one credit grant and one token.
- `POST /api/v1/lunas` with `{kind: "diy"}` creates the entry in state `setup_step = pay` with its Stripe customer, and opens the activation Checkout. `fulfillCheckout` for `luna_kind=diy_activation` grants the credit, mints the DIY token **already linked to that entry** (no separate bind step), and moves the entry to `setup_step = token`.
- `MintDIY` and its 5-per-hour limit go: one paid checkout gives one token. An unpaid entry left in `pay` for 24 hours is deleted together with its Stripe customer.
- Retail Lunas cost nothing to add. The card in the box already proves a purchase.

### 5.4 Cancel, unlink, delete, proration

| Action | What happens |
|---|---|
| **Turn off cloud backup** (one Luna) | Today's `CancelBilling` logic, run per entry: report that customer's usage, `ScheduleFinalCharge`, `canceling` state, `finishCanceling`, then `deleteLunaCopiesNow`. Other Lunas are untouched. |
| **Unlink** (the device leaves the account) | The address and tunnel are torn down. The confirm dialog asks what to do with the cloud backup: keep it (the subscription continues, and the entry shows "Not linked") or delete it (the same steps as Turn off). The default is open question Q3. |
| **Delete this Luna** (entry has no linked device, or is dead) | Final charge, purge every identity, delete the Stripe customer's subscription, free the address, then mark the entry `removed_at`. The row is kept for 90 days so `luna_events` stays readable. |
| **Payment fails** | The 30-day countdown runs for that entry only. Its backups pause, and the others keep running. |
| **Factory reset (M-22)** | The reset's "Unbinding Luna Connect" step unlinks the device. The entry and its backups stay according to the same keep-or-delete choice, asked inside the reset flow. |
| **Proration** | Nothing to prorate on the metered prices: the bill is the average GB stored over the calendar month. The **$3 monthly minimum** is per Luna. Two Lunas side by side during a move would each pay at least $3 plus tax. Proposal: scale the minimum by the days the subscription was active in its first and last month. See Q2. |

The Luna's estimate copy keeps "plus tax" everywhere: "About $8.40 this month, plus tax".

## 6. Onboarding

### 6.1 Two layers

The account and its Lunas are separate wizards. The account layer runs once per person. The Luna layer runs once per Luna, and its state lives on the Luna entry (`lunas.setup_step`), not on the account.

| Layer | Steps | State |
|---|---|---|
| Account | `sign-in-or-create → verify` | Derived from `accounts.email_verified`. `accounts.onboarding_path/step` are deleted. |
| Luna | retail: `token → name → backup → plug-in → done`. DIY: `pay → token → name → backup → plug-in → done` | `lunas.setup_step`, `lunas.setup_kind` |

Mapping of today's values: `code`/`bind` → `token`; `card` → `pay`; `diy-code`/`oss-code` → `token` (DIY shows the minted token rather than asking for one); `domain`/`name` → `name`; `backup`/`copies` → `backup`; `plug-in` becomes a stored step; `verify` moves to the account layer; `welcome` becomes the landing page. `ResolveOnboarding`, `persistOnboardingIfChanged`, `onboardingStatusFields`, `loadBoundDevice` and `SetOnboardingProgress` are replaced by `ResolveLunaSetup(luna)`, a pure function of one entry's columns.

### 6.2 Routes

- `/onboarding` (printed on the quick-start card) and `/diyonboarding` stay as landing pages. Signed out, they show "Create an account" with "Already have an account? Sign in" as an equal button, not a footnote. Signed in, they go straight to the Luna layer: `/lunas/add?kind=retail` or `?kind=diy`.
- `/lunas` replaces the "Devices" page. `/lunas/:id` shows one Luna. `/lunas/:id/setup` resumes that Luna's wizard. `/lunas/add` starts a new one.
- `/setup?token=` on the Luna stays exactly as it is. Connect builds the link per Luna from that entry's address and token (`buildLunaSetupLink`).

### 6.3 The four flows, for someone who already has an account

| Flow | Path |
|---|---|
| **Retail card token** | Scan or open `/onboarding` → (signed in) "Add the Luna from your quick-start card" → type the token → name → cloud backup → plug in → done. If the token is already on this account, jump to that entry's setup. If it's on another account, keep today's refusal. |
| **DIY** | `/diyonboarding` → (signed in) "Adding a Luna you installed yourself costs $1 plus tax. It counts toward this Luna's cloud backup." → Checkout → token shown once with the installer instructions → name → cloud backup → plug in → done. |
| **Second Luna** | `/lunas` → **Add a Luna** → "Did your Luna come with a quick-start card?" Yes → retail; No → DIY. |
| **Replacement** | `/lunas/:id` on the old Luna → **Replace this Luna** → the same chooser, with `replaces_luna_id` set → at **name**, offer to move the old address (§8.2) → at **done**, show "Bring back files from `kitchen`" (§7). |

Account-level guards that already exist stay: email verification before binding, the per-IP and per-account bind rate limits in `Bind`, and step-up for showing a device token (`RevealDeviceCode`, now `POST /api/v1/lunas/:id/token`).

### 6.4 Luna-side setup wizard

`SetupPage.jsx` keeps `welcome → preflight → account → name → done`. Two changes:

- The **done** step asks Connect (through lunad's status) whether a read grant targets this Luna. If one does, it adds a row: "Bring back files from `kitchen`. Open Settings → Cloud backup to start." No link appears before an Admin exists.
- Phrase setup in Settings (`PhraseSetupModal`, `RecoveryPhraseCard`) gets a second choice: **Use the phrase from your old Luna**. The browser checks that the typed phrase opens the old Luna's self-sealed record (proof that it's really that phrase). It then derives this Luna's keys from the same phrase, so one phrase opens both. See Q4.

## 7. Copying from one Luna to another ("Bring back files")

### 7.1 What is copied

| Thing | Copied? | How |
|---|---|---|
| Files in shared cloud backups | **Yes** | Latest version by default, or a date the Admin picks. They are restored into a folder the Admin picks on the new Luna, under each backup's original relative path, never overwriting (the `(restored 16 Oct)` naming from protect-rebuild §4). |
| Private items | **Yes, by their owner** | The owner enters their own phrase on the new Luna. Files land in a new private item owned by them. Admins never see them. |
| Which folders were backed up | **Offered** | "Back up these folders again" creates the same cloud backups on the new Luna, paused until confirmed (same rule as M-23). |
| Version history | **No** | It stays on Connect under the old entry until that entry is deleted. |
| User accounts | **No** | Users live only in `luna.db`, and the signed user list holds no names. People create new accounts, and each can reuse their old phrase (§6.4). |
| Settings, share links, Office, network | **No** | They are not in cloud backup, and share links point at the old address anyway. |
| Address | **Optional** | Moved on Connect, with guards (§8.2). |
| Subscription and credit | **No** | The new Luna has its own. |
| Drive backups | **Not needed** | If the drives come along, their manifests bring the backups back, paused (M-23). |

### 7.2 Trust and permissions

- **Read grant (Connect).** On the old Luna's page in Connect, the account holder picks **Bring files to another Luna**, chooses the target Luna, and confirms with their password. Connect writes a `luna_read_grants` row bound to `target_device_id`, valid for 14 days. It can be revoked, and it is void if the target unlinks. The grant lets that device GET the source entry's records and packs, nothing else. A Luna's own retired identities ("Backups from before <date>") need no grant.
- **The recovery phrase is the boundary.** The grant only reaches ciphertext. The browser derives keys with the **source** `luna_id` (key derivation is `HKDF(info = label ‖ luna_id)`, protect-rebuild §5). It then opens that phrase's self-sealed copy of the **source** signing public key (`findMyKeys`, `self` records). Every record is checked against that key. Never trust `cloud_identities.signing_public` from Connect, and never the new Luna's own identity. If the self record doesn't open, the browser stops and sends nothing.
- **Then the browser hands the new Luna the opened backup keys.** For shared backups these are the per-version backup keys and dedup keys, as `restoreFromPhrase` does today. For private items, the owner's browser unseals the private pack keys for their scope.
- **Lunad does the heavy lifting** in a new `backup/cloud/import.rs`. It downloads packs, decrypts them, checks pack ids and chunk HMACs, and writes files. This avoids streaming terabytes through a browser.

### 7.3 Not bringing H-06 back

- Every restored path comes from a tree whose hash is in a snapshot record signed by the source identity. The browser sends only keys and the snapshot id, never `source_drive` or `source_path`.
- The destination is a drive and folder that an Admin (or, for private items, the owner) picks on the new Luna. Write access to it is checked when each file is written, not only when the import starts.
- Names are canonicalized before they become paths: reject `..`, absolute paths, `.luna-*` names and anything `safe_name` (`files/mod.rs`) refuses. Writes stay inside the chosen folder after symlinks are resolved.
- The endpoints (`/api/v1/cloud/import/*`) require a signed-in Admin, or for private items the signed-in owner. They are unreachable until setup is finished, so they belong on the H-01a list.

### 7.4 UI on the new Luna

In Settings → Cloud backup, a **Bring back files** card replaces `CloudRestoreCard` and `PrivateRestoreCard`:

| State | Surface | Actions |
|---|---|---|
| Nothing to bring back | No card | — |
| Source available | `From kitchen` (`InlinePill`) · "Backed up until November 12" | `Bring back files` |
| Asking | Recovery phrase boxes (the `RecoveryPhraseCheck` component), destination drive and folder, version (`Latest` / pick a date) | `Start` |
| Running | "Bringing back files · 412 of 1,930 GB" | `Pause` |
| Done | "Brought back 18,204 files to `Family`." Plus "Back up these folders again?" | `Set up backups` |
| Private items waiting | For each person who has private items in the source: "Your private items from `kitchen` can come back once you enter your recovery phrase." | `Bring back mine` (owner only) |

## 8. Switching Lunas

### 8.1 The flow

1. On Connect: old Luna → **Replace this Luna** → add the new Luna (retail or DIY, §6.3).
2. Optionally move the address (§8.2), or give the new Luna its own.
3. Turn on cloud backup for the new Luna (its own subscription).
4. Set up the new Luna (`/setup?token=`), then **Bring back files** with a recovery phrase (§7).
5. When the new Luna's first cloud backup finishes, its Connect page and the old Luna's page both show: "`garden` has its own cloud backup now. Delete `kitchen`'s cloud backup to stop paying for it?" The action is **Delete `kitchen`**, with a confirm that says what's lost (older versions, private items not yet brought back).

### 8.2 Moving an address

Today a Connect session cannot point `<name>.luna.servers.libreloom.org` at a different box, because an account holds only one Luna. With several Lunas and a move step, a stolen session plus a $1 DIY Luna could redirect a household's address to the attacker's box. That box would get a valid certificate, and browsers and the companion apps would send it their logins. That makes the move a Chain 4-class path, so it gets its own guards:

- **Password step-up**, the same check as showing a device token, charged to the sign-in rate limits.
- **Old Luna online:** the move waits until an Admin approves it on the old Luna (Settings → Luna Connect, "Move `kitchen.luna.servers.libreloom.org` to `garden`?"). An old Luna that is still running has no reason to give its address away silently.
- **Old Luna offline for 72 hours or more:** the move happens 24 hours after the request. An email goes to the account at once with a **Cancel this move** link, and the old Luna's page shows a countdown. Waiting is acceptable when the old Luna is dead anyway.
- **The tunnel rotates.** Connect deletes the old tunnel and creates a new one for the target (`teardownDeviceRemote` + `applyDeviceDomain`). The old tunnel token stops working, and a copied one cannot follow the address.
- **Every move is logged** in `luna_events` and shown on both Lunas' pages.

### 8.3 Companion apps after a move or reset

The apps pin nothing today, so a different Luna behind the saved address looks the same as the old one. Lunad should expose a stable, public **Luna instance id**: a random value minted at setup and rotated by factory reset (`GET /api/v1/health` or the pairing payload). The desktop app (`SessionData`) and the Android app (`BackupPrefs`) store it at sign-in. If the address answers with a different id, the app stops syncing and uploading, discards the saved session, and asks the person to sign in again: "This address now belongs to a different Luna. Sign in again to keep using it." After sign-in, the Android app drops `drive_id`/`drive_label` when that drive is unknown and asks where photos go. No app needs to know about several Lunas per account (Q9).

## 9. UI changes

### Connect web (`luna/connect/web`)

| Page | Change |
|---|---|
| `LunaPage.jsx` → `LunasPage.jsx` (`/lunas`) | A list of Luna cards: name, address, online state, cloud backup state and cost, `Finish setup` when `setup_step` is not `done`. `Add a Luna` button. "Not linked" and "Backups from before <date>" show as rows inside the card, not as separate Lunas. |
| New `LunaDetailPage.jsx` (`/lunas/:id`) | Today's toolbar (address, change address, show device token with password, unlink), plus: cloud backup and payment for this Luna, `Replace this Luna`, `Bring files to another Luna`, `Delete this Luna`, recent events. |
| `OnboardingPage.jsx` | Split into `AccountStart` (sign in or create, verify) and `AddLunaWizard` (per entry, §6). The step lists `OFFICIAL_STEPS`/`DIY_STEPS` and the `PROGRESS_KEY` localStorage resume go. Resume comes from `lunas.setup_step`. |
| `BackupsPage.jsx` | Grouped by Luna entry, with that entry's identities under it (`LunaPicker` becomes a per-entry selector). "Turn off payment" moves to the Luna's own page. |
| `CheckoutButton.jsx`, `useCheckoutReturn` | Carry `luna_ref`. `checkoutReturnPages` gains `/lunas/:id`. |
| Admin console (`AdminAccountsPage.jsx`, `AdminDashboardPage.jsx`) | An account shows its Luna entries. The credit form picks a Luna. Revenue sums over entries. |

### Luna web (`luna/web`)

| Place | Change |
|---|---|
| Settings → Cloud backup (`CloudBackupCategory.jsx`) | Drop `CloudRestoreCard`/`PrivateRestoreCard` and add **Bring back files** (§7.4). Change "Add a payment card at Luna Connect" to "Turn on cloud backup for this Luna at Luna Connect", linking to `/lunas/<luna_ref>`. Add an "Earlier cloud backups" row with `Delete` once the new backup is complete. |
| Settings → Luna Connect (`RemoteCategory.jsx`) | The path trail becomes `Luna Connect → Lunas → <name> → Change address`. Add the pending address-move approval card (§8.2). |
| Reset (`ResetLunaCard.jsx`) | The M-22 unlink step gains the keep-or-delete cloud backup question. Copy: "Your cloud backups stay on Luna Connect unless you delete them." |
| Setup (`SetupPage.jsx`) | Done step: the bring-back row (§6.4). |
| Phrase setup | "Use the phrase from your old Luna" (§6.4). |
| Dev: `dev/fake/handlers/settings.js`, `dev/scenarios/settings.scenarios.js`, `recovery.scenarios.js`, `setup.scenarios.js`, `dev/contract/known-gaps.js` | Remove the restore routes and scenarios. Add import, grant and address-move scenarios. |

### Companion apps

Desktop and Android: instance-id pinning and the re-sign-in path (§8.3). Nothing else.

## 10. Security review

| Risk | Where it could come back | Design answer |
|---|---|---|
| **M-09** (key on removable media) | Anything that persists the seed outside `luna.db` | No drive copy exists. The scrub on mount (§3.2), `signing_public` is immutable, and deleting a Luna retires its identity on Connect. |
| **Chain 1** (a stranger becomes first Admin on a fresh Luna and keeps it) | "Bring back files" on a new Luna; `/setup?token=` for added Lunas | Import endpoints need a signed-in Admin after setup is finished (H-01a list). A Luna taken over with the attacker's own token sits on the attacker's account, which can't hold a grant from the victim's account. Even with a grant, the victim's phrase is needed. A $1 activation per DIY token, and no free bulk mint, makes the token-planting step slightly costlier. The real fix stays H-01a. |
| **Chain 4** (a Connect session reaches the household's front door) | Device-token reveal across more Lunas; address move; read grants | Reveal stays a POST with password step-up (7fa420e7). Address move adds step-up, old-Luna approval or a 24-hour wait, an email, and tunnel rotation. Grant creation needs step-up and is bound to one device. Every reveal, move, grant, unlink and delete is written to `luna_events` and emailed. Still open from the audit's fix direction: customer sign-out everywhere, password reset, and tunnel-token rotation on demand. Several Lunas per account widen what one stolen session reaches, so these should land before or with phase 3. |
| **Tunnel tokens** | `Status` hands the tunnel token to a device-token holder | Unchanged per Luna. Rotate on address move and on unlink. `Status` only answers for the device currently linked to the entry. |
| **Binding races** | Entry cap; subscription claim; DIY fulfilment; grant use | The cap is enforced in the claiming statement (§4.1). `claimSubscription` becomes an `UPDATE lunas … WHERE stripe_subscription_id IS NULL OR = ?` per entry, and the loser's subscription is cancelled (today's pattern). DIY fulfilment is keyed by the checkout session (§5.3). Grants are checked against `target_device_id` on every request. |
| **First-Admin takeover via reset** | Reset keeps the device token (M-22) | The reset flow unlinks if asked. The new identity after a reset cannot read or sign as the old one. Old backups need the phrase. |
| **H-06** | The new import | §7.3. |
| **Cross-Luna reads** | One device token reading another Luna's storage | `storageScope` allows only the entry's own identities, plus grants (§4.2). |

## 11. Phases

| Phase | Scope | Notes |
|---|---|---|
| **0. Remove drive identity rebuild** | §3.1 and §3.2 in lunad, the store request signing, Connect's `lunaSigValid` and `/storage/luna-ids`, the restore cards. | Closes M-09 and removes H-06. Ships on its own. Until phase 4, a dead Luna's files come back through Connect web downloads. |
| **1. Connect data model** | `lunas`, `cloud_identities`, per-entry storage, quota, usage and retention (§4), `POST /storage/identity`, `luna_ref` in `Status`, the lunad identity tied to `luna_ref`. | Rewrite `schema.go` (SQLite and Postgres). No migration. Keep one Luna per account at the API edge until phase 3. |
| **2. Billing per Luna** | Gates G1-G4 first. Then a customer per entry, checkouts with `luna_ref`, webhooks, `card_checks`, the DIY activation price, the cancel, unlink and delete table, the per-entry final charge. | Stop and report if a gate fails. |
| **3. Onboarding and Connect UI** | Account and Luna layers, `/lunas` pages, Backups grouped by Luna, the admin console. Lift the one-Luna restriction. Customer sign-out everywhere. | Chain 4 follow-ups land here. |
| **4. Switching** | Read grants, `backup/cloud/import.rs`, Bring back files, address move with its guards, the delete-old-Luna prompt, phrase reuse. | Largest lunad piece. |
| **5. Apps and loose ends** | Instance-id pinning in desktop and Android, gallery scenarios, fake lunad, contract gaps, docs. | |

Documents to update after review (not edited by this plan): `luna/docs/protect-rebuild/plan.md` §5 (signing-key copies on drives, "Luna id … after database loss", "Luna loses its database", "binding again … reattaches"), its "Decisions recorded 2026-10-17" identity line, `luna/connect/docs/billing-managed-payments.md` ("keep the $1 card check exactly as it is"), and the Connect paragraph in `luna/AGENTS.md`.

## 12. What to delete

- **Lunad:** `identity.rs` drive functions and their tests (`copy_is_written_on_create`, `second_lunas_copy_is_kept_alongside`, `recover_finds_only_the_matching_id`, `known_id_recovers_the_drive_copy_instead_of_minting`, `connect_only_id_without_a_drive_copy_is_not_adopted`, `empty_db_takes_back_the_key_…`, `ids_only_connect_lists_are_never_adopted`, `several_drive_copies_are_narrowed_by_connect`, `unreachable_connect_uses_the_one_drive_copy`, `unreachable_connect_with_two_drive_copies_mints_nothing`, `connect_is_asked_with_the_database_lock_free`); `drives/mod.rs:1871` `adopt_copies_the_cloud_signing_key_tagged_with_luna_id`; the copies in `drives/mod.rs:658-667` and `drives/format/run.rs:470-476`; the `cloud_signing_keys` schema; `net/connect.rs` `list_luna_ids` and its tests; `store.rs` request signing and its header tests; `api/cloud_restore.rs`, `backup/cloud/recover.rs`, `api/cloud_restore_private.rs`, `backup/cloud/private_recover.rs`; `manifest.luna_id`.
- **Contract and fake lunad:** the six `/api/v1/cloud/restore*` cases in `web/src/dev/contract/cases.js:118-123`, the restore tests in `dev/fake/handlers/settings.test.js`, and (regenerated by the next full run, not by hand) their entries in `lunad-responses.json`.
- **Luna web:** `CloudRestoreCard`, `PrivateRestoreCard`, `lib/cloudRestore.js`, `lib/privateRestore.js` and their tests; restore routes in `dev/fake/handlers/settings.js`; restore entries in `dev/contract/known-gaps.js` (`GET /api/v1/cloud/restore-private/records/…`); restore scenarios in `recovery.scenarios.js`, `settings.scenarios.js` and `setup.scenarios.js`.
- **Connect:** `MaxDevicesPerAccount`; `lunaSigValid`, `storageSigWindow` and the takeover branch of `authorizeLuna`; `ListLunaIDs` and `GET /storage/luna-ids`; `oss_payments`, `humanVerified` and `markCardChecked`; `MintDIY` and `POST /account/diy-token`; the `accounts` columns for billing, quota, purge and onboarding; `onboarding_state.go` (`loadBoundDevice`, `ResolveOnboarding`, `defaultCodeStep`, `isOnboardingCodeStep`); `onboarding.go` `Backups` and `SetOnboardingProgress`; `deleteCloudCopiesNow`'s account-wide form; the device columns `account_id`, `name`, `subdomain` and `tunnel_*`.
- **Connect web:** the one-Luna `LunaPage` copy ("One Luna on this account"), `OFFICIAL_STEPS`/`DIY_STEPS` and the onboarding localStorage resume.

## 13. Open questions for the user

> **Q1. Where does the $1 credit live?** Under option A each Luna has its own Stripe customer, so the $1 for a DIY Luna becomes credit on **that Luna's** cloud backup bill. It doesn't sit in an account-wide pool. Is that what "added to credit" means? The alternative is a pooled credit that Connect tracks itself and grants to whichever Luna bills next, which is more code and gets less help from Stripe.
>
> **Q2. The $3 monthly minimum per Luna.** Two Lunas during a move both pay at least $3 plus tax a month. Should the minimum scale by active days in a Luna's first and last month, be waived for the old Luna once a replacement exists, or stay as it is?
>
> **Q3. Default when unlinking.** Should unlinking a Luna keep its cloud backup (and keep billing it) by default, or delete it by default? The plan asks every time, so this question only decides which choice is highlighted.
>
> **Q4. Reusing a recovery phrase.** Should the new Luna offer "Use the phrase from your old Luna"? It makes the move one phrase instead of two. The cost is that one leaked phrase then opens both Lunas' backups for that person.
>
> **Q5. What "bring back" restores.** Latest version only, with a date picker for older ones? Or should it also copy older versions into the new Luna's history? That would mean re-uploading each version, or adopting the old backup keys, which edges back toward identity moving.
>
> **Q6. Did "dupe everything" mean ongoing mirroring?** This plan reads it as "every Luna gets its own copy of every Connect concept, and moving copies data once". Did you also want two live Lunas to keep each other's files in sync? That would be a separate feature.
>
> **Q7. Cap on Lunas per account.** 25 (today's cloud-identity cap), lower, or none?
>
> **Q8. Address move guards.** Are 72 hours offline plus a 24-hour wait with an email right for moving an address away from a dead Luna? Is an Admin approval on the old Luna right when it is still online?
>
> **Q9. Several Lunas in the companion apps.** The apps would still handle one Luna at a time, and pinning would only detect a swap. Do you want a Luna switcher in the desktop and Android apps (say, for a second household's Luna)?
>
> **Q10. Earlier backups after a reset.** Should Luna delete the "Backups from before <date>" by itself, 30 days after the new first backup completes? Or should it only offer to delete them?
