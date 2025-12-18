# Backend Hardening TODO

- App catalog hardening:
  - Pin images to stable tags and document update cadence.
  - Avoid port collisions (dynamic assignment or reverse-proxy mapping).
  - SearXNG base URL should be templated for reverse proxy; ensure health path is valid.
  - Nextcloud AIO avoids direct `/var/run/docker.sock` bind (use socket proxy or alternative).
  - Ollama GPU settings: ensure compose works without swarm; consider `runtime: nvidia`/device requests.
  - Tighten CORS defaults (Ollama/ConvertX) from `*` unless explicitly set.
- Project goals: add SSO/IdP integration and feature-matrix endpoints; cloud backup/relay/AI helper wiring.
- Added manually by @plainskill: Let's create the missing backend tests as well!

## Caddy/ACME Hardening Checklist

Goal: make Caddy reload + ACME issuance reliable, configurable, and observable.

1) Config schema + defaults
   - Add Caddy operational toggles to config (`server/backend/internal/network/types.go`, `server/backend/internal/config/config.go`, `server/backend/configs/libreserv.yaml`).
   - Suggested fields: `enabled/mode`; `reload` (retries, backoff_min/max, jitter); `logging` (output stdout|stderr|file, file path, format console|json, level); `acme` (enabled, mode http-01|dns-01, dns_provider/env, email_override, poll_timeout).
   - Decide precedence and fallback when admin API is unreachable.

2) Reload hardening
   - Centralize reload strategy in `internal/network/caddy.go` (`reloadCaddy`): prefer Admin API `POST /load` with retries/backoff/jitter; optional fallback to `caddy reload --config ...`; return structured errors.
   - Make reload idempotent/safe with clear file/read errors and request timeouts.

3) Configurable logging output
   - Stop hardcoding `log { output stdout }` in the Caddyfile template (`internal/network/caddy.go`).
   - Template log block for stdout/stderr/file (ensure directory exists/perms) and optional JSON format; document defaults.

4) No-op/disabled mode when Caddy is missing
   - Add disabled/noop execution path in `internal/network/caddy.go` and API handlers: allow route CRUD/config generation but make reload/issue operations no-op with clear response/warning.
   - `GetStatus` should surface “disabled/noop” distinctly from errors.

5) Surface errors to callers
   - Ensure route CRUD returns reload failure context (`internal/api/handlers/network.go`, `internal/network/caddy.go`).
   - Fix fire-and-forget ACME issuance (sync or job model with `POST /acme/request`, `GET /acme/jobs/{id}`).
   - Implement real domain configuration endpoints (`ConfigureDomain`, `GetDomainConfig`) backed by Caddy config/DB instead of placeholders.

6) Real cert lifecycle (beyond reload)
   - Choose approach: native Caddy Admin API automation vs external ACME client.
   - DNS-01 support: provider config/env validation, cleanup for temp records.
   - Lifecycle endpoints: `POST /api/v1/network/acme/request`, `GET /api/v1/network/acme/status?domain=...`, optional renew; define cleanup semantics for route delete.

7) Tests
   - Reload retry/backoff cases (transient 502/503, timeouts, permanent failure error text).
   - No-op mode coverage without `caddy` binary/admin API.
   - ACME request flow: `RequestCert` adds/removes `acme-auto`, error propagation consistent.

8) Docs/operator guidance
   - How to configure Admin API; enable DNS-01 (providers/permissions); log targets and production defaults; explain noop/disabled modes.
   - Document domain config endpoints and persistence, once implemented.

9) Nice-to-have follow-ups
   - Structured error types (`ErrCaddyDisabled`, `ErrAdminUnreachable`, `ErrReloadRejected`, etc.).
   - Metrics counters (reload attempts/failures, issuance failures).
   - Audit log entries for issued/failed certs and acme-auto route creation.
