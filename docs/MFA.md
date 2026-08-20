# MFA / Two-Factor Authentication — Design & Contract

Shared contract for the MFA build. All agents (backend-core, backend-webauthn,
frontend) build against this so there's no drift. LibreServ is WAN-accessible
by design; MFA is the primary login defense, chosen over captcha.

## Requirements (from product)
- **Required for admins.** A user with the `admin` role must have ≥1 enabled MFA
  method; can't gain/hold admin without it.
- **Methods:** TOTP, **email-OTP (default option)**, passkey, security key.
  (Passkey + security key are both WebAuthn — platform vs roaming authenticator.)
- **Users choose what counts** as their valid 2FA: they enable any subset.
- **Login flow:** a *selection UI* lists the user's enabled methods → user picks
  → the method's *entry UI* (TOTP code / email OTP / passkey prompt / security
  key prompt) → verify → logged in.
- **At least one method must stay enabled** (no softlock).
- **Backend & frontend verified** to avoid softlock.

## Data model (migration `003_mfa.sql`)
- `mfa_methods`: `id` (uuid), `user_id`, `type`
  (`totp|email|passkey|security_key`), `label`, `enabled` (bool),
  `created_at`, `last_used_at`, `data` (JSON; encrypted where sensitive).
  - `totp`: `data = {secret_enc}` (AES-GCM; key from config — fail closed if unset).
  - `email`: `data = {}` (uses `users.email`).
  - `passkey`/`security_key`: `data = {credential_id, pub_key, sign_count, transports, aaguid}` (WebAuthn).
- `mfa_recovery_codes`: `id`, `user_id`, `code_hash` (bcrypt), `used_at`, `created_at`.
- `users`: add `mfa_required` (bool) — set true for admins; enforced (can't be
  true without ≥1 enabled method).

## Enforcement (no softlock) — the hard requirement
- A user with any enabled method must keep ≥1 enabled: `DELETE` last enabled
  method → **409 rejected**.
- Admins must have MFA: can't grant `admin` to a user without MFA; an admin
  can't disable their last method.
- Recovery codes are a **fallback** (not in the login picker); generated once,
  single-use, hashed at rest. Usable from the entry screen via "use recovery code".
- Password alone **never** logs in an MFA-enabled user — login completes only
  after a valid MFA verify (or recovery).

## Login flow (the contract)
1. `POST /auth/login {username, password}`
   - valid + user has ≥1 enabled method → `200 {status:"mfa_required", mfa_token, methods:[{type,label}]}` (short-lived `mfa_token` scoped to MFA verify only; **not** authenticated).
   - valid + no MFA → session (current behavior).
   - invalid → `401` (rate-limited as today).
2. `POST /auth/mfa/challenge {mfa_token, type}` — optional; email triggers OTP send, passkey/security_key returns WebAuthn challenge.
3. `POST /auth/mfa/verify {mfa_token, type, payload}` → valid: issue session; invalid: `401`.
   - `totp`/`email`: `payload={code}`. `passkey`/`security_key`: `payload={assertion}`.
4. `POST /auth/mfa/recover {mfa_token, recovery_code}` → valid: issue session; invalid: `401`.

## Enrollment endpoints (session-authed + CSRF)
- `GET /auth/mfa/methods` → user's methods.
- `POST /auth/mfa/totp/setup` → `{secret, otpauth_uri}`. `POST /auth/mfa/totp/verify {code}` → enables.
- `POST /auth/mfa/email/setup` → sends OTP. `POST /auth/mfa/email/verify {code}` → enables.
- `POST /auth/mfa/webauthn/register/begin {label, type}` → `{challenge}`. `POST /auth/mfa/webauthn/register/finish {credential}` → enables. (WebAuthn agent.)
- `DELETE /auth/mfa/methods/{id}` → disable (**409 if last enabled**).
- `POST /auth/mfa/recovery-codes` → generate (return codes **once**). `GET /auth/mfa/recovery-codes` → `{remaining}` (codes not re-shown).

## Agent split — file ownership (agent-blame-enforced, no edit conflicts)
- **agent-8bcd78ea (backend core):** `internal/auth/mfa.go` (model/service: TOTP, email-OTP, recovery, enforcement), `internal/api/handlers/mfa.go` (enrollment + login-flow endpoints), migration `003_mfa.sql`, router.go `mfa` route group, main.go wiring. **Defines the `WebAuthnVerifier` interface** that the webauthn package implements.
- **agent-692b7a0a (backend WebAuthn):** `internal/auth/webauthn/` (separate package: register + verify ceremonies via `github.com/go-webauthn/webauthn`), `internal/api/handlers/mfa_webauthn.go`. **Implements** 8bcd78ea's `WebAuthnVerifier` interface. `passkey` + `security_key` = WebAuthn platform vs roaming attachment.
- **agent-df41f958 (me, frontend):** MFA enrollment UI (per method), login selection UI → entry UI per type, recovery-code flow, "can't disable last" UX, admin-required prompt. Built against the contract above.

**Seam:** 8bcd78ea owns `mfa.go` + `handlers/mfa.go` + router wiring. 692b7a0a owns `webauthn/` + `handlers/mfa_webauthn.go` (separate files only). The login-flow `verify` for webauthn types dispatches through the `WebAuthnVerifier` interface 8bcd78ea defines + 692b7a0a implements — agree the interface signature in this thread before coding the seam.

## Verification (no softlock) — required, blocking
Backend (8bcd78ea): can't DELETE last enabled method (409); admin can't disable all MFA / can't be admin without MFA; login with MFA returns `mfa_required` (not session); verify pass/fail; recovery works; TOTP + email verify.
Backend (692b7a0a): WebAuthn register→verify round-trip (ceremony) against a virtual authenticator; passkey + security_key both enroll.
Frontend (me): selection UI lists enabled methods; entry UI per type; "disable last" blocked in UI; recovery flow; admin-required enrollment gate.
Integration (one of us): admin enrolls TOTP → logout → login → password → pick TOTP → code → in; AND enroll → attempt delete last → blocked.
## Decisions (post-contract, user-directed)

1. **WebAuthn options nesting (confirmed empirically by agent-c7ee3400):** both
   `register/begin` and `mfa/challenge` (passkey/security_key) return
   `{options: {publicKey: <PublicKeyCredential{Creation,Request}Options>}}`.
   Frontend calls `prepareCreationOptions/prepareRequestOptions(response.options.publicKey)`
   — NOT `response.options`. Buffer fields base64url no-pad end-to-end.

2. **MFA always-required for admins; block UI usage (not sign-in):** an admin with
   no enabled MFA method hits a fullscreen `MfaBlocker` (every app route replaced)
   until they enroll. Gated in `App.jsx RequireAuth` on
   `me.role === "admin" && me.mfa_enabled === false`. Backend exposes `mfa_enabled`
   (bool) on `/auth/me`.

3. **`/auth/register` is NUKED** (route + handler + `allow_registration` config).
   No public self-signup. Account creation is admin-initiated only: manual-add
   (`POST /users/`) OR invite-user.

4. **Setup MFA step:** explicit step in the setup wizard immediately after account
   creation (NOT transparent background email). Since SMTP isn't configured at that
   point (SMTP step comes later), the step offers TOTP/passkey/security-key (not
   email); email can be added from MyProfile after SMTP setup.

5. **Invite-user (replaces register):** admin clicks "Add user" → choose manual-add
   (existing) OR invite-by-email (if SMTP configured). Invite: admin picks role +
   email → backend sends invite token → invitee follows link → onboards (username +
   password + MFA; MFA required if role=admin). Backend endpoints: `POST /users/invites`,
   `GET /auth/invite/{token}`, `POST /auth/invite/{token}/redeem`. The only public
   account-creation path.
