# Fix Plan (Critical Hardening)

## 1) Auth & Browser Security
- Add CSRF protection for browser flows (issue/validate tokens; require on all state-changing endpoints).
- Strengthen password policy (length/complexity) and add account lockout/backoff per username/IP; tighten auth/setup rate limits.
- Harden CORS for production (configured origins only; wildcard only for development).

## 2) Domain/ACME/Caddy Integration
- Add endpoints to probe DNS (A/AAAA/CNAME) and port reachability.
- Implement ACME flow via Caddy with status polling, error handling, and rollback on failure.
- Apply Caddy route updates atomically; validate config before write.

## 3) Support Channel Sandboxing
- Introduce a jailed support command runner (namespace/chroot, no Docker group), with a minimal allowlist and enforced timeouts.
- Keep PathPolicy enforcement; parse/deny risky docker commands/flags (volumes, exec, cp).
- Emit audit logs for all support actions; add retention/rotation controls.

## 4) Licensing/Entitlement UX
- Add `/api/v1/license/status` and CLI to show license_id/support_level/validity.
- Surface entitlement state in diagnostics and setup UI flows.

## 5) Reliability & Error Handling
- Improve monitoring/backups/network error handling and rollback paths.
- Add tests for ACME/DNS probes, CSRF/auth lockouts, and support sandbox behavior.
