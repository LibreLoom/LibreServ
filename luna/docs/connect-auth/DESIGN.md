# Luna Connect device authentication

This is the implementation contract for Luna Connect device identity and authentication. It replaces the Device ID plus six-hex Verification code pair with a single **device token**, and keeps the rolling device credential for everything after pairing.

The first redesign (commit `1c76679e`) split the old token into a public Device ID and a short reusable code. That made pairing weak (six hex characters, reversibly stored at Connect), added a dead-end "Not available" state, and needed a separate one-time setup grant for off-LAN setup. This revision goes back to one token, keeps the rolling credential, and removes the extra machinery.

Backup formats, backup keys, retention, and cloud archive behavior are out of scope.

## Decisions

- The **device token** is 20 random Crockford-base32 characters (about 100 bits), displayed in groups of four (`7K4M-2Q9X-R8N3-6T5W-1PZH`) and stored and compared ungrouped, uppercase, case-insensitive, with lookalike letters normalized.
- The device token does three jobs. It **identifies** the device to Connect, it **pairs** the device to an account, and it **proves** whoever is at an off-LAN setup page holds this Luna's token.
- The device token is **never** the ongoing credential. After pairing, Luna authenticates with the rolling `auth_token`.
- Tokens are **minted only** by Connect staff (admin console, singly or in bulk) and by the DIY flow after its $1 card check. Nothing else mints, rotates, or replaces a token. A lost token is replaced by support minting a new one.
- Connect stores only a **hash** of the token, so Connect cannot show it again. The token is displayed once, at the moment it is minted.
- Pairing may happen any number of times. The token is accepted only while the device is `unbound` or has an active `pairing` attempt, and is ignored while `bound`.
- Pairing requires a verified Connect account and a running Luna. The first valid claim wins and closes pairing.
- The ongoing device credential (`auth_token`) is 32 random bytes encoded as unpadded base64url. It is never displayed to a user.
- The auth token does not expire with time. Luna refreshes it every five minutes when possible and immediately after reconnect.
- Refresh invalidates the old token. Connect may accept the previous token for 60 seconds on the refresh endpoint only, to tolerate a lost response.
- Unbind, reset-with-disconnect, and explicit revocation invalidate the auth token immediately.
- The device token, Connect device row, and cloud identity survive credential refresh, unbind, and factory reset.
- Off-LAN first-Admin setup requires the full device token, **checked by Luna against its own file**. Connect is not asked, and no separate setup grant or setup key exists.
- Physical access to a Luna is ownership. The token is not rotated on resale or handover.
- The current one-device-per-Connect-account limit remains unchanged.
- The old permanent-token authentication path stays removed.

## Connect device states

| State | Meaning | Device token | Auth token |
| --- | --- | --- | --- |
| `unbound` | No account owns the device | Accepted | None |
| `pairing` | A verified account submitted a valid token and Luna has not claimed it | Accepted for the active attempt | None |
| `bound` | Account linked and Luna authenticated | Ignored | Valid |
| `revoked` | Emergency invalidation | Rejected | Invalid |

Transitions:

```text
unbound -- account starts pairing with a valid token --> pairing
pairing -- Luna claims pairing online --> bound
pairing -- cancel, disconnect, or 10-minute timeout --> unbound

bound -- refresh --> bound (auth token replaced)
bound -- unbind --> unbound (auth token revoked)
bound -- revoke --> revoked (auth token invalidated)
revoked -- password-stepped-up account disconnect --> unbound
revoked -- password-stepped-up account recovery --> pairing
```

Only one pairing attempt may exist per device. Starting another attempt replaces an expired attempt but must not displace a live attempt for another account.

## Connect API contract

Account-authenticated routes use the existing Connect session cookie, verified-email requirement, Origin check, and CSRF protection.

### Start pairing

`POST /api/v1/devices/pair`

```json
{ "device_token": "7K4M-2Q9X-R8N3-6T5W-1PZH" }
```

Returns:

```json
{ "pairing_id": "..." }
```

Creates a ten-minute pending pairing attempt. Errors are generic and must not reveal whether a token exists.

### Poll pairing as the account

`GET /api/v1/devices/pair/{pairing_id}`

Returns `{ "status": "waiting" }` or `{ "status": "bound", "device_id": "..." }`.

### Claim pairing as Luna

`POST /api/v1/devices/pair/claim`

```json
{ "device_token": "7K4M-2Q9X-R8N3-6T5W-1PZH" }
```

Verifies the active attempt and atomically binds the device. A valid token with no active pairing attempt returns the same generic 404 as an invalid token, but does not consume a failure attempt; unbound Luna polls here every ten seconds. An invalid token does consume failure attempts.

Returns:

```json
{
  "auth_token": "...",
  "device_id": "...",
  "refresh_after_seconds": 300
}
```

### Refresh the rolling credential

`POST /api/v1/token/refresh`

Authorization: `Bearer <auth_token>`

Returns a new `auth_token`. The current token never expires. The previous token is accepted only here for 60 seconds after replacement.

### Existing device routes

`GET /api/v1/status`, `POST /api/v1/domain`, `POST /api/v1/unregister`, signing-public registration, and all `/api/v1/storage/*` routes use `Authorization: Bearer <auth_token>`.

Credential failures use distinct machine codes:

- Invalid or unknown token: `401`.
- Previously valid token after unbind: `403` with `code: "device_unbound"`.
- Previously valid token after revocation: `403` with `code: "device_revoked"`.

User-facing messages remain generic. Luna uses `device_unbound` to finish a lost unbind response and `device_revoked` to enter recovery-required state.

### Unbind and revoke

The existing Luna and account unbind routes atomically set the device to `unbound` and invalidate the auth token. They retain the device token.

Account revoke sets the device to `revoked` and invalidates the auth token. Account recovery, with password step-up, moves `revoked` to `pairing`; Luna then claims it with its device token.

## Minting

A token is created in exactly two places:

- **Staff:** the admin console mints unbound tokens, singly or in bulk, optionally against an order reference and kind. Each token is shown once for the `TOKENS` magazine or quick-start print.
- **DIY:** after the one-time $1 card check, the DIY flow mints one token for that account and shows it once. The account owns the device from the start.

Connect stores `hash(token)` as the lookup and comparison value, with a short non-secret hint for support. There is no sealed copy, no reveal route, and no password-gated re-display. Support looks up devices by order reference or hint.

## Pairing rate limits

All verification paths, including unauthenticated Luna polling, share persisted counters. An invalid token cannot be attributed to a device, so limits are per account and per client IP.

Default limits:

- Twenty failed attempts per account per hour.
- Fifty failed attempts per trusted client IP per ten minutes.

Connect derives client IP only through trusted proxy configuration. It must not trust a client-supplied `Origin` header as proof of network location. A shared address (carrier-grade NAT) can group unrelated users, so these are abuse limits, not authentication.

Errors remain generic. Counters and limits survive restarts. Successful pairing closes the attempt immediately.

## Luna local files and state

- `device-token`: the ungrouped uppercase Crockford token, mode `0600`. Written by the installer, read from the factory `TOKENS` magazine, or set later in the Device token section's **Advanced** area. It survives factory reset, unbind, and pairing.
- `connect-credential`: the rolling auth token, mode `0600`, never returned by an API.
- `connect.json`: hostname, tunnel, and bound-state configuration.
- `connect-unbind-pending`: retained when revocation has not yet been confirmed.

Factory `TOKENS` lines contain exactly one field:

```text
7K4M2Q9XR8N36T5W1PZH
```

The installer and factory-magazine reader take the first line and write `device-token`. Manual setup asks for the device token as one value, and an empty value skips Connect.

The Device ID, Verification code, `device-uid`, `pairing-code`, `setup-token`, and `first_user_secret` files and fields are removed. No compatibility reader is required under the repository's early-development policy.

Replacing the token in Advanced is local-only. It performs no Connect request and does not change the auth token, tunnel, binding, or cloud state; the new token matters the next time Luna pairs or an off-LAN setup is attempted.

## Luna behavior

### Unbound

Luna polls the pairing-claim route with its device token. If no pairing is active, it remains unbound. It must not start a tunnel or accept the token as local login proof. With no token on disk, Luna does not poll and Connect stays off.

### Pairing

A successful claim stores the auth token, marks Connect bound, and starts normal status polling. The account then provisions the domain.

### Bound

Luna uses the auth token for all Connect requests. It refreshes every five minutes when possible and before normal work after reconnect. Refreshing never changes the device token or account. The device token stays on disk but Connect ignores it.

### Unbind

Luna or the Connect account revokes the token. Luna stops the tunnel, removes bound configuration, deletes the auth token, and returns to unbound with its device token intact. If confirmation fails, Luna retains only what is needed to retry, enters `connect-unbind-pending`, stops remote access, and blocks pairing.

### Revoked

A rejected auth token stops tunnel and Connect operations and shows a reconnect-required state. Recovery must be initiated from the Connect account or staff tooling.

### Factory reset

Reset always asks:

- **Keep Connect:** retain auth token, device token, and bound configuration; clear local Luna data only.
- **Disconnect:** use the normal unbind flow, keeping the device token. If Connect is unavailable, complete the local reset but retain pending revocation state and block remote access and pairing until it succeeds.

The device token survives both choices. Reset must never delete the only credential while Connect still considers the device bound.

## First local Admin

- LAN first registration remains available under the existing Host, Origin, and client-IP checks.
- Off-LAN first registration requires the full device token. Luna compares it, case-insensitively and ignoring grouping, with `device-token` on disk and creates the first Admin only on a match. A missing or wrong token is refused with plain-language copy; remote first login never fails open.
- Connect's onboarding links to `/setup#token=<token>` to prefill the field. The token is in the URL fragment, never the query string, and Luna removes it from the visible URL after reading it.
- The setup page asks for the token only when the request is off-LAN. The daemon makes the authoritative client-IP decision.
- The auth token and the setup URL query string are not accepted as substitutes.
- Once any local user exists, normal Admin-only registration rules apply.

## USB account recovery

Preserve the existing physical recovery-file envelope and account selectors for every Connect state.

- A clean recovery USB with the existing `luna-recover.luna` JSON file is sufficient for bound, unbound, pairing, and revoked Lunas.
- No device token, rolling credential, or Connect approval is required.
- Connect binding does not change local USB recovery.
- Changing the local device token does not affect USB recovery.
- The recovery flow remains browser-only and does not require a terminal.

This is a local physical-recovery mechanism, separate from Connect authentication. It accepts physical possession of Luna and clean recovery media as the recovery authority. Protection against a stolen powered-off device is a separate disk-encryption/secure-boot concern.

## User-facing terminology

The settings section is **Device token** and its one field is the **device token**. Connect never calls it a setup code, device code, Device ID, or Verification code. The rolling credential is never named in product copy.

Factory reset offers **Keep Connect** and **Disconnect**. Disconnect explains that remote access stops and the device can be connected again later.

## Tests required

- Pairing state transitions, expiry, cancellation, and first-claim-wins behavior.
- Generic errors and persisted rate limits.
- Rolling-token refresh, overlap, lost-response retry, and immediate unbind/revoke invalidation.
- Token reuse across unbind and factory reset without remaining valid while bound.
- Token minting by staff and by the DIY flow only; hash-only storage with no reveal path.
- Local-only token replacement in Advanced.
- Factory-reset keep/disconnect choices and pending revocation, with the token surviving both.
- Off-LAN first-Admin refusal without the token, refusal with a wrong token, success with the correct token, and no fallback to the auth token.
- Existing status/domain/storage routes reject legacy permanent tokens.
