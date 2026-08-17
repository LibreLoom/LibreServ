# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅ Yes    |
| Previous| ⚠️ Limited |

## Reporting Security Issues

**Do not open public issues for security vulnerabilities.**

Email security reports to: `trafficcone@onetrue.name` and `max@plainskill.net`

## Threat Model: WAN-Accessible by Design

**LibreServ is WAN-accessible by design.** Remote access — a custom domain
with automatic HTTPS (Caddy + ACME) — is a core, first-class goal (see
GOALS.md → Remote access). Once a user configures a domain, the web UI and
its authentication endpoints (`/auth/login`, `/auth/register`,
`/auth/password-reset/*`) are **publicly reachable from the internet**, not
just the LAN. Custom domains are discoverable via DNS and certificate-
transparency logs, so automated scanners *will* find these endpoints.

This is the central fact for every security decision in this codebase:

- Treat the auth endpoints as internet-exposed. Brute-force and
  credential-stuffing scans are the baseline threat, not a hypothetical.
- Primary defenses are **strong passwords, rate limiting, and 2FA/MFA** —
  not captchas. Captcha is friction on every legitimate login (against the
  non-technical-user ethos) and is a weak match for a botnet; it is **not**
  a substitute for rate limiting or 2FA.
- Public registration is itself an attack surface (account-creation spam);
  prefer admin-invited users over open public registration.

### Captcha — decision: do not ship for v1

Considered [Cap](https://github.com/tiagozip/cap) (self-hosted PoW captcha)
for `login` / `register` / `password-reset/request`. **Decided against.**

1. Rate limiting already caps brute-force per IP (`/auth/login` 10/min,
   `register` 3/hr, `password-reset` 5/min) — captcha's marginal
   bot-stopping over rate limiting is small.
2. PoW captcha stops naive scripts (curl) but a headless browser solves PoW
   trivially, so it doesn't stop a determined/botnet attacker that per-IP
   rate limiting also struggles with. The real answer there is 2FA.
3. Captcha is friction on every legitimate login — directly against the
   "non-technical user, minimal friction" product ethos.
4. Self-hosted captcha is operational burden + a fail-closed lockout risk
   on a device pitched as "no terminal recovery."

**Invest instead:** 2FA/MFA (TOTP/passkeys — already "coming soon" below),
keep strong rate limiting, IP-ban after repeated failures, and gate public
registration (admin-invited users). Revisit captcha **only if**
credential-stuffing against a WAN-exposed instance proves a real problem
*after* 2FA + rate-limit hardening — and if so, prefer adaptive captcha
(triggered after N failures) over always-on.

## Security Measures

LibreServ implements the following security measures:

### Authentication & Access Control
- JWT-based authentication with bcrypt password hashing
- Configurable password requirements
- Rate limiting on auth and sensitive endpoints
- Two-factor authentication (coming soon)

### Input Validation
- CORS strict defaults (no wildcard unless explicitly configured)
- SQL injection prevention via parameterized queries
- XSS protection via template auto-escaping
- Path traversal prevention with allow/deny policies
- UTF-8 validation and sanitization

### Network Security
- Security headers (X-Frame-Options, HSTS, CSP recommendations)
- Dev mode security warnings and production guardrails
- Audit logging for all administrative actions
- Global request body size limit: **10 MB** enforced via middleware

### Container Security
- Non-root container configurations where possible
- Hardened container runtime with pinned image tags
- Network isolation recommendations

## Rate Limiting

LibreServ enforces the following per-IP or per-user rate limits, reset every minute:

| Route Prefix | Limit | Scope |
|---|---|---|
| `/api/v1/setup/complete` | 15 requests/min | Global (by IP) |
| `/api/v1/setup/preflight` | 60 requests/min | Global (by IP) |
| `/api/v1/setup/status` | 180 requests/min | Global (by IP) |
| `/api/v1/auth` | 120 requests/min | Global (by IP) |
| `/api/v1/email` | 10 requests/min | Per user |
| `/api/v1/users` | 60 requests/min | Per user |
| `/api/v1/support` | 30 requests/min | Per user |
| `/api/v1/backups` | 20 requests/min | Per user |
| `/api/v1/support/sessions` | 20 requests/min | Per user |
| `/api/v1/support/diagnostics` | 10 requests/min | Per user |
| `/api/v1/support/session` | 15 requests/min | Per user |
| `/api/v1/security` | 60 requests/min | Per user |
| `/api/v1` (general) | 300 requests/min | Per user |

Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) are included in every response.

## Automated Scanning

This project uses automated security scanning:
- **Dependency Scanning**: Weekly Trivy scans for Go and container dependencies
- **Container Scanning**: Container image vulnerability scanning
- **Go Vulnerability Check**: govulncheck for Go packages
- **Static Application Security Testing (SAST)**: gosec and staticcheck on every push

## CI Security Policy

### Blocking High-Severity Security Findings

Our CI pipeline automatically blocks commits that introduce **high-severity security vulnerabilities** as detected by gosec.

**What gets blocked:**
- Security issues with **high severity** AND **high confidence** ratings
- These represent confirmed security vulnerabilities that must be addressed

**What does NOT get blocked:**
- Medium or low severity issues
- Issues with medium or low confidence ratings
- Style or code quality issues (handled by staticcheck separately)

**For Contributors:**
1. Run `gosec -severity high -confidence high ./...` locally before committing
2. Address any high-severity findings before submitting pull requests
3. If you believe a finding is a false positive, document it with a `#nosec` annotation and explain why

**Remediation:**
When a commit is blocked:
1. Review the SARIF results uploaded as CI artifacts
2. Fix the underlying security issue
3. Re-push the corrected code

The security team is automatically notified of all blocked commits for review.
