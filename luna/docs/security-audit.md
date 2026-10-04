# Luna security audit — October 2026

Point-in-time deep security review of the full Luna codebase: `crates/lunad`,
`crates/luna-core`, `web`, `desktop`, `mobile`, `connect` (Go service + web),
`quick-start`, `os/`, and `scripts/`. Scope covered authentication and sessions,
setup gating, the HTTP API and WebDAV surface, file/path confinement, uploads,
public share links, drive detection/mount/format, updates, recovery, the Connect
cloud service (accounts, Stripe, tunnels/DNS, backup object storage, admin),
both frontends, the desktop and Android companions, OS installer scripts, and
dependency advisories.

## Method

- Manual review of every security-relevant code path listed above.
- Dependency scanning via direct OSV.dev API queries against `Cargo.toml`,
  `Cargo.lock`, and `go.mod` (the container lacks a C linker, so `cargo-audit`
  and `govulncheck` could not run end-to-end; OSV covers the same advisory
  databases for crates and Go modules).
- `npm audit` against `luna/web`, `luna/connect/web`, and `luna/quick-start`
  lockfiles.
- Repo-wide secrets scan (API keys, private keys, tokens, passwords).

## Findings

### Medium

**M1 — Media decoders and drive tools parse untrusted input as root**

`lunad` runs as root on the OS image, and several child processes parse
attacker-controlled or device-controlled data with that privilege:

- `luna/crates/lunad/src/gallery/mod.rs:1009` — `ffmpeg` on user-uploaded
  videos for previews (and `ffprobe` at `:1070`)
- `luna/crates/lunad/src/gallery/heif.rs:352` — external HEIF decoder on
  user-uploaded images
- `luna/crates/lunad/src/drives/smart.rs:102` — `smartctl` parses drive-reported
  data (a malicious USB enclosure firmware can return crafted SMART output)

All invocations use argument arrays — no shell injection was found. The risk is
a parser vulnerability in ffmpeg/imagemagick/smartmontools yielding root code
execution; any member with upload capability can feed media to the decoders.
Recommend running decode workers as a dedicated unprivileged user (or under
`bwrap`/`seccomp`), and considering a non-root `lunad` with narrowly-scoped
privileged helpers for mount/partition operations.

**M2 — Cleartext HTTP on the LAN is the security boundary**

Luna serves plain HTTP on the LAN. The household password (at login), the
`luna_session` and `luna_csrf` cookies, share-link tokens, and WebDAV
`Authorization: Basic` device tokens all transit unencrypted. An attacker on the
same LAN (compromised IoT device, rogue client, ARP spoofing) can steal a
session or device token and gain full account access; HTTPS is only available
remotely through the Connect tunnel.

The Android app mirrors this tradeoff intentionally:
`luna/mobile/app/src/main/res/xml/network_security_config.xml` permits cleartext
for `.local`/`.lan`/`.home`/`localhost`/`luna.local`, and `PrivateLan.kt` allows
raw-socket HTTP for RFC1918/loopback/link-local addresses.

This is a deliberate product decision for a LAN appliance, but it is the
single largest systemic risk in the design. Consider optional self-signed TLS
with trust-on-first-use pinning in the companion apps, and document the LAN
threat model for users.

**M3 — Physical access yields root with no additional barrier**

- `luna/os/work/rootfs/etc/shadow` — `root:::` (blank root password) gives a
  root shell on the local console. There is no SSH/dropbear in the image, so
  this is console-only, but `/var/lib/luna` is unencrypted: `jwt_secret`, the
  Connect `device-token`, `connect.json`, the tunnel credential, and `luna.db`
  (Argon2 password hashes, share-link tokens, session hashes) are all readable.
- `luna/crates/lunad/src/system/recovery.rs` — the recovery-USB flow resets
  passwords with physical access (device token required only when configured).

Physical access already implies game-over for an unencrypted appliance, so this
is mostly a documentation/threat-model item: users should know a stolen or
borrowed Luna exposes all credentials on it. A console password or full-disk
encryption would raise the bar but conflicts with the no-terminal support
model; decide deliberately.

### Low

**L1 — Share-link tokens stored in plaintext at rest**

`luna/crates/lunad/src/api/access/access_admin.rs:433-510` — `access_links`
stores the raw link token (`token` column) so the owner can re-copy the URL;
lookups correctly use `token_hash` (BLAKE3). Anyone who obtains `luna.db` or a
backup of it gains all live share links. A show-once + hash-only design would
remove the exposure at the cost of re-displaying URLs.

**L2 — Connect admin bearer token lives in `localStorage`**

`luna/connect/web/src/context/AdminAuthContext.jsx:9-19` — the static admin
token is stored in `localStorage`, readable by any JavaScript on the origin.
A single XSS in the admin app exfiltrates a credential with full admin scope
and no expiry. Account sessions use `HttpOnly` cookies; moving admin auth to
the same mechanism (or issuing short-lived admin session tokens instead of the
static bearer) removes this asymmetry. No XSS was found, so this is hardening.

**L3 — HIBP response body unbounded in Connect**

`luna/connect/internal/auth/hibp.go:77` — `io.ReadAll(resp.Body)` has no size
cap; the lunad equivalent caps at 1 MiB (`luna/crates/lunad/src/hibp.rs`). The
endpoint is a hardcoded HTTPS URL so exploitation requires a HIBP-side
compromise, but the fix is one line (`io.LimitReader`).

**L4 — EPUB reader still permits remote resource loads**

`luna/web/src/lib/epubReader.js` — book content is sanitized (scripts, `on*`
attributes, `javascript:`/`vbscript:` URLs stripped) and rendered in a sandboxed
iframe with a `script-src 'none'` CSP meta. Images, fonts, and CSS in a book can
still reference remote URLs, leaking reading activity and the reader's IP to
publisher-controlled hosts and allowing content swap after distribution.
Restricting subresource loads to `data:`/`blob:` would close it.

**L5 — Connect admin login reveals valid admin emails by timing**

`luna/connect/internal/api/handlers/admin_auth.go:44` —
`err == sql.ErrNoRows || auth.VerifyPassword(hash, …)` short-circuits before
bcrypt for unknown emails, so response timing distinguishes registered from
unregistered admin addresses (rate-limited to 10 attempts/min/IP). Compare
against a precomputed dummy hash, as lunad already does for its own login.

**L6 — Built image advertises SSH over mDNS that does not exist**

`luna/os/work/rootfs/etc/avahi/services/ssh.service` (and `sftp-ssh.service`)
are stock Debian avahi announcements for `_ssh._tcp`/port 22, but no SSH daemon
ships in the image. Harmless but misleading to network scanners and inventory
tools; remove the service files during the image build.

## Dependency advisories — assessed, not exploitable in current use

| Package | Advisory | Assessment |
|---|---|---|
| `jsonwebtoken 9.3.1` (lunad) | GHSA-h395-gr6q-cpjc — malformed standard claims parsed as missing | Not exploitable: `Validation::new(HS256)` requires `exp`, so a malformed `exp` fails closed; `nbf` is never issued or checked; signature verification is unchanged. Upgrade to ≥10.3.0 when convenient. |
| `lru 0.16.4` (via `dav-server`) | RUSTSEC-2026-0253 — double-free on `pop` with panic-on-drop keys | Unreachable: dav-server cache keys are `String`/`PathBuf` with infallible drops. Follow the upstream bump when released. |
| `glib 0.18.5` (desktop) | GHSA-wrw7-89jp-8q8g — `VariantStrIter` unsoundness | Desktop does not iterate GVariant string arrays via that API; latent only. Upgrade the GTK stack when convenient. |
| `proc-macro-error 1.0.4` | RUSTSEC-2024-0370 — unmaintained | Build-time only; no action required. |
| `golang.org/x/crypto 0.56.0` (connect) | GO-2026-5932 — `openpgp` unmaintained | Connect does not import `openpgp`; not applicable. |
| `luna/web` npm (12: 6 high, 6 mod) | `lodash-es`, `nanoid`, `braces`, `chokidar`, `sass`, chevrotain/langium/mermaid-parser chain | All build-time or transitive parser deps. No lodash import exists in app source; `nanoid` misuse is internal to `@excalidraw`; `braces`/`chokidar`/`sass` are build tools. Worst reachable case is a malicious diagram file triggering a client-side parser issue. Track upstream excalidraw/mermaid updates. |
| `connect/web`, `quick-start` npm | — | 0 findings. |

## Areas reviewed with no issue found

**lunad (Rust daemon).** Argon2 password hashing with a constant-time dummy
hash for unknown users; JWT sessions explicitly HS256 with `exp` required and a
DB-backed token version for revocation; `luna_session`/`luna_csrf` cookies with
double-submit CSRF; device tokens BLAKE3-hashed at rest; `jwt_secret` and data
dir at `0600`/`0700`; setup routes anonymous only before first account and only
for LAN-like clients; forwarding headers trusted only from loopback peers;
share-link tokens are 192-bit random, hashed for lookup, rate-limited on
password attempts; office/link proof JWTs carry and enforce explicit `typ`
claims. Path confinement (`luna-core/src/path.rs`) does lexical rejection,
canonical containment, `O_NOFOLLOW` opens, and post-open fd identity checks —
public file serving re-verifies the jail on every request, restricts to media
types, forces `attachment` disposition where needed, and rate-limits public
uploads by both IP and link. All SQL is parameterized. All external commands
use arg arrays (no shell). Drive adopt/format/erase is admin-gated and refuses
the system disk. Updates verify minisign signatures → `SHA256SUMS` → per-file
checksums with atomic swaps; cloudflared is a pinned release verified by
SHA-256. `LUNA_CONNECT_URL` release builds reject non-HTTPS unless
loopback/private. HIBP k-anonymity breach checks send only a 5-char hash
prefix, cap the response, and fail open. Mock drives are disabled in release
unless `LUNA_MOCK_DRIVES=1`. WebDAV accepts session/device tokens via cookie,
Bearer, or Basic — never the household password — and rate-limits failed Basic.

**Luna Connect (Go).** Random session tokens stored SHA-256-hashed with 7-day
expiry and `HttpOnly`/`Secure`/`SameSite=Lax` cookies; CSRF via double-submit
plus Origin validation on cookie-authenticated mutations; device tokens hashed
at rest; Stripe webhooks signature-verified with 5-minute tolerance and 64 KiB
payload cap; provider secrets AES-GCM-sealed at rest with the at-rest key
required in production; device hostname validation rejects unsafe labels and
prevents off-zone construction; backup object paths reject `..`, `\`, and NUL
with per-account/per-device ownership enforced in parameterized SQL; local and
B2 stores both re-validate keys and confine to account/device namespaces; admin
login is rate-limited, admin sessions are hashed, the static admin token is
compared in constant time, and `/admin/seed` is loopback-only without an
explicit seed token; outbound HTTP clients (Resend, HIBP, providers) refuse
redirects so credentials can't leak to a redirect target.

**Frontends.** No `dangerouslySetInnerHTML`/`innerHTML`/`eval` sinks in shipped
code; the diagram iframe's `postMessage` handler validates both `origin` and
`source`; EPUB content is actively sanitized and sandboxed; Connect web reads
CSRF from the cookie and sends it as a header.

**Mobile/desktop.** Android stores the token in `EncryptedSharedPreferences`
(AES-256-SIV/GCM), upgrades public addresses to HTTPS, restricts cleartext to
local domains/IPs, and has no WebView bridge. The GTK desktop stores sessions
in the OS keychain (Secret Service/Keychain/Credential Manager) with a `0600`
file fallback, bounded HTTP timeouts, and no TLS verification overrides.

**OS/scripts.** `flash-disk.sh`, `find-media.sh`, `start.sh`, `network-up.sh`
quoted correctly; block-device candidates come from sysfs enumeration filtered
by name patterns; `/proc/cmdline` overrides only set `LUNA_*` variables used as
quoted paths; installer media trust is inherent to booting the ISO. Mock
servers/tokens live in `luna/scripts/mocks/` and are dev-only. No real secrets
in the repository — only test placeholders.

## Recommendations (priority order)

1. **M2** — Decide on LAN TLS: self-signed cert + TOFU pinning in the
   companions would eliminate LAN session theft. Otherwise document the model.
2. **M1** — Sandbox or drop privileges for ffmpeg/HEIF/smartctl workers.
3. **M3** — Document the physical-access threat model; consider a console
   password or at-rest encryption roadmap.
4. **L2** — Move Connect admin auth off `localStorage` (HttpOnly session).
5. **L1** — Consider hash-only share-link tokens with show-once UX.
6. **L3/L5** — Cap the HIBP body; add a dummy-hash compare to admin login.
   Both are one-line fixes.
7. **L6** — Delete the stock `ssh.service`/`sftp-ssh.service` avahi files from
   the image build.
8. **Deps** — Bump `jsonwebtoken` ≥10.3.0 and `dav-server`'s `lru` when a fixed
   release exists; keep excalidraw/mermaid current.
