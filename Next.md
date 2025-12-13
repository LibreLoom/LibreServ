# Next Steps

## Support channel enforcement
- Add signed handshake for support sessions (code+token HMAC) on device and relay; reject expired/revoked sessions at connect.
- Enforce scopes and PathPolicy on file/shell ops; require +docker scope for volume access; add audit logging for every support command/file access with session ID, scope, path, outcome.

## Support server hardening
- Persist cases/messages to SQLite; add auth roles for agents/devices.
- Add SSE/WebSocket for live updates and status changes; include support_level from license.
- Queue/priority handling based on support_level (priority vs community).

## Licensing polish
- Surface entitlement state in `/api/v1/support/diagnostics`; add `GET /api/v1/license/status`.
- Add CLI to load/validate entitlement files and show license_id/support_level.
- Prepare for transfer limits/cooldown in the licensing server (future).

## Relay improvements
- Add HMAC auth, session TTL enforcement, rate limits, and structured logs to the relay.
- Optionally add MTLS between device and relay; keep relay dumb (no token storage).

## Setup/security
- Tighten CORS to configured prod origins; add CSRF for browser flows; strengthen password/rate-limit policies on auth/setup.
- Add domain/ACME/DNS probe endpoints for the setup wizard.

## QA
- Add tests for license validation, support session validation, and path policy checks.
- Use local `GOCACHE` for sandboxed test runs.
