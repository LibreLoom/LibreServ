# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅ Yes    |
| Previous| ⚠️ Limited |

## Reporting Security Issues

**Do not open public issues for security vulnerabilities.**

Email security reports to: `security@plainskill.net`

or

Report via Gitea: https://gt.plainskill.net/LibreLoom/LibreServ/security/advisories/new

## Security Measures

LibreServ implements the following security measures:

### Authentication & Access Control
- JWT-based authentication with bcrypt password hashing
- Configurable password requirements (12+ characters, alphanumeric)
- Rate limiting (5 attempts, 15-minute lockout)
- Optional 2FA support

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

### Container Security
- Non-root container configurations where possible
- Hardened Docker Compose with pinned image tags
- Network isolation recommendations

## Automated Scanning

This project uses automated security scanning:
- **Dependency Scanning**: Weekly Trivy scans for Go and Docker dependencies
- **Container Scanning**: Docker image vulnerability scanning
- **Go Vulnerability Check**: govulncheck for Go packages

## Hardening Checklist

See [TODO.md](TODO.md) for current security hardening status and future enhancements.
