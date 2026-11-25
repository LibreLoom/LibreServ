# Luna Connect device authentication

This is the implementation contract for the device identity and authentication redesign. It replaces the permanent Crockford bearer token with a high-entropy device identifier, a reusable pairing verification code, and a rolling device credential.

Backup formats, backup keys, retention, and cloud archive behavior are out of scope.

## Decisions

- The public device identifier (`device_uid`) is a 20-character random Crockford-base32 value, displayed in four-character groups.
- The pairing verification code is six hex characters. It is reusable, but accepted only while the device is `unbound` or has an active `pairing` attempt.
- Pairing requires a verified Connect account and a running Luna. The first valid claim wins and closes pairing.
- The ongoing device credential (`auth_token`) is 32 random bytes encoded as unpadded base64url. It is never displayed to a user.
- The auth token does not expire with time. Luna refreshes it every five minutes when possible and immediately after reconnect.
- Rotation invalidates the old token. Connect may accept the previous token for 60 seconds on the refresh endpoint only, to tolerate a lost response.
- Unbind, reset-with-disconnect, and explicit revocation invalidate the auth token immediately.
- Device UID, Connect device row, and cloud identity survive token rotation and unbind.
- Removing local pairing material is local-only and performs no Connect request.
- Factory reset always asks whether to keep or disconnect Connect.
- A failed disconnect enters a pending state, stops remote access, blocks new pairing, and retries revocation.
- Remote first-Admin setup uses a separate one-time setup grant. The device UID, verification code, and auth token are never accepted directly as first-Admin proof.
- The current one-device-per-Connect-account limit remains unchanged.
- The old permanent-token authentication path is removed rather than supported in parallel.

## Connect device states

| State | Meaning | Verification code | Auth token |
| --- | --- | --- | --- |
| `unbound` | No account owns the device | Accepted | None |
| `pairing` | A verified account submitted valid pairing data and Luna has not claimed it | Accepted for the active attempt | None |
| `bound` | Account linked and Luna authenticated | Ignored | Valid |
| `revoked` | Emergency invalidation | Rejected | Invalid |

Transitions:

```text
unbound -- account starts pairing with valid UID + code --> pairing
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
{
  "device_uid": "7K4M-2Q9X-R8N3-6T5W-1PZH",
  "verification_code": "A3F91C"
}
```

Returns:

```json
{ "pairing_id": "..." }
```

Creates a ten-minute pending pairing attempt. Errors are generic and must not reveal whether a device UID exists.

### Poll pairing as the account

`GET /api/v1/devices/pair/{pairing_id}`

Returns `{ "status": "waiting" }` or `{ "status": "bound", "device_id": "..." }`.

### Claim pairing as Luna

`POST /api/v1/devices/pair/claim`

```json
{
  "device_uid": "7K4M-2Q9X-R8N3-6T5W-1PZH",
  "verification_code": "A3F91C"
}
```

Verifies the active attempt and atomically binds the device. A valid UID and verification code with no active pairing attempt returns the same generic 404 as invalid material, but does not consume a failure attempt; unbound Luna polls here every ten seconds. Invalid material does consume failure attempts.

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

Returns a new `auth_token`. The current token never expires. The previous token is accepted only here for 60 seconds after rotation.

### Existing device routes

`GET /api/v1/status`, `POST /api/v1/domain`, `POST /api/v1/unregister`, signing-public registration, and all `/api/v1/storage/*` routes use `Authorization: Bearer <auth_token>`.

Credential failures use distinct machine codes:

- Invalid or unknown token: `401`.
- Previously valid token after unbind: `403` with `code: "device_unbound"`.
- Previously valid token after revocation: `403` with `code: "device_revoked"`.

User-facing messages remain generic. Luna uses `device_unbound` to finish a lost unbind response and `device_revoked` to enter recovery-required state.

### Setup grant for remote first-Admin creation

`POST /api/v1/devices/{device_id}/setup-grant`

Account-authenticated. Creates a new single-use grant, invalidating any previous unused grant, and returns `{ "setup_grant": "..." }`. The grant is bound to the account and device and expires after ten minutes.

`POST /api/v1/devices/setup-grant/consume`

Authorization: `Bearer <auth_token>`

```json
{ "setup_grant": "..." }
```

Marks the grant used. Luna calls this before creating the first local Admin.

Connect builds the setup URL with the grant in the `#setup_grant=` URL fragment, never the query string. Luna removes it from the visible URL after reading it.

### Unbind and revoke

The existing Luna and account unbind routes atomically set the device to `unbound` and invalidate the auth token. They retain the device UID and verification code.

Account revoke sets the device to `revoked` and invalidates the auth token. Account recovery, with password step-up, moves `revoked` to `pairing`; Luna then claims it with its UID and verification code.

## Pairing rate limits

All verification paths, including unauthenticated Luna polling, share persisted counters.

Default limits:

- Five failed attempts per device per ten minutes.
- Twenty failed attempts per account per hour.
- Fifty failed attempts per trusted client IP per ten minutes.
- Twenty failed attempts per device per ten minutes when the trusted client IP matches the device's recently observed public IP.

Connect derives client IP only through trusted proxy configuration. It must not trust a client-supplied `Origin` header as proof of network location. A public-IP match is a UX relaxation, not authentication; carrier-grade NAT may make unrelated users share an address.

Errors remain generic. Counters and limits survive restarts. Successful pairing closes the attempt immediately.

## Luna local files and state

- `device-uid`: the ungrouped uppercase Crockford identifier. This is not secret.
- `pairing-code`: the uppercase six-hex-character verification code, mode `0600`.
- `connect-credential`: the rolling auth token, mode `0600`, never returned by an API.
- `connect.json`: existing hostname, tunnel, and bound-state configuration.
- `connect-unbind-pending`: retained when revocation has not yet been confirmed.

Factory `TOKENS` lines contain exactly two whitespace-separated fields:

```text
7K4M2Q9XR8N36T5W1PZH A3F91C
```

The installer and factory-magazine reader split that line and write `device-uid` and `pairing-code` separately. Manual setup asks for Device ID and Verification code as separate values.

The legacy `device-token` and `setup-token` files and `first_user_secret` path are removed. No compatibility reader is required under the repository's early-development policy.

Removing local pairing material deletes only the local verification code. It performs no Connect request and does not change the auth token, tunnel, binding, or cloud state. Losing the code means recovery is required if the device later needs to pair again.

## Luna behavior

### Unbound

Luna polls the pairing-claim route with its UID and verification code. If no pairing is active, it remains unbound. It must not start a tunnel or accept the code as local login proof.

### Pairing

A successful claim stores the auth token, marks Connect bound, and starts normal status polling. The account then provisions the domain and obtains a setup grant.

### Bound

Luna uses the auth token for all Connect requests. It refreshes every five minutes when possible and before normal work after reconnect. Refreshing never changes the device UID or account.

### Unbind

Luna or the Connect account revokes the token. Luna stops the tunnel, removes bound configuration, deletes the auth token, and returns to unbound. If confirmation fails, Luna retains only what is needed to retry, enters `connect-unbind-pending`, stops remote access, and blocks pairing.

### Revoked

A rejected token stops tunnel and Connect operations and shows a reconnect-required state. Recovery must be initiated from the Connect account or staff tooling.

### Factory reset

Reset always asks:

- **Keep Connect:** retain auth token and bound configuration; clear local Luna data only.
- **Disconnect:** use the normal unbind flow. If Connect is unavailable, complete the local reset but retain pending revocation state and block remote access and pairing until it succeeds.

Reset must never delete the only credential while Connect still considers the device bound.

## First local Admin

- LAN first registration remains available under the existing Host, Origin, and client-IP checks.
- The setup UI always permits an optional one-time setup key and submits it when present. It does not guess LAN versus off-LAN from the hostname; the daemon makes the authoritative client-IP decision.
- Off-LAN first registration requires a valid setup grant. Luna verifies and consumes it through Connect using its auth token before creating the first Admin.
- The grant is single-use and expires after ten minutes.
- The device UID, verification code, auth token, and setup URL query string are not accepted as substitutes.
- Once any local user exists, normal Admin-only registration rules apply.

## USB account recovery

Preserve the existing physical recovery-file envelope and account selectors for every Connect state.

- A clean recovery USB with the existing `luna-recover.luna` JSON file is sufficient for bound, unbound, pairing, and revoked Lunas.
- No device token, pairing code, rolling credential, or Connect approval is required.
- Connect binding does not change local USB recovery.
- Removing local pairing material does not affect USB recovery.
- The recovery flow remains browser-only and does not require a terminal.

This is a local physical-recovery mechanism, separate from Connect authentication. It accepts physical possession of Luna and clean recovery media as the recovery authority. Protection against a stolen powered-off device is a separate disk-encryption/secure-boot concern.

## User-facing terminology

The settings section remains **Device token**. Its fields are **Device ID** and **Verification code**. The rolling credential is never named in product copy.

Factory reset offers **Keep Connect** and **Disconnect**. Disconnect explains that remote access stops and the device can be connected again later.

## Tests required

- Pairing state transitions, expiry, cancellation, and first-claim-wins behavior.
- Generic errors and persisted rate limits, including trusted-IP relaxation.
- Rolling-token refresh, rotation overlap, lost-response retry, and immediate unbind/revoke invalidation.
- Device UID and verification code reuse across unbind/reset without remaining valid while bound.
- Local-only verification-code removal.
- Factory-reset keep/disconnect choices and pending revocation.
- Off-LAN first-Admin grant consumption and replay rejection.
- Existing status/domain/storage routes reject legacy permanent tokens.
