# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅ Yes    |
| Previous| ⚠️ Limited |

## Reporting Security Issues

**Do not open public issues for security vulnerabilities.**

Email security reports to: `trafficcone@onetrue.name`, `max@plainskill.net`, and `w.n.lazypanda5050@gmail.com`

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
- Hardened Docker Compose with pinned image tags
- Network isolation recommendations

## Rate Limiting

LibreServ enforces the following per-IP or per-user rate limits, reset every minute:

| Route Prefix | Limit | Scope |
|---|---|---|
| `/api/v1/setup/complete` | 15 requests/min | Global (by IP) |
| `/api/v1/setup/preflight` | 60 requests/min | Global (by IP) |
| `/api/v1/setup/status` | 180 requests/min | Global (by IP) |
| `/api/v1/auth` | 120 requests/min | Global (by IP) |
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
- **Dependency Scanning**: Weekly Trivy scans for Go and Docker dependencies
- **Container Scanning**: Docker image vulnerability scanning
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
