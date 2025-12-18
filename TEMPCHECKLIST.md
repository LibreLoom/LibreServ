# Implementation Checklist — Caddy/ACME Hardening (from `CODEX_BACKEND_TODO.md`)

## Goal

Make Caddy reload + ACME certificate issuance **reliable, configurable, and observable**:
- Prefer **Caddy Admin API** reload with **retries/backoff**
- Allow **configurable logging target**
- Support **no-op / disabled mode** when Caddy isn’t present
- **Surface reload/issuance errors** to API callers (not just logs)
- Implement a **real cert lifecycle**, including **DNS-01** (not just “reload the Caddyfile”)

## 1) Config schema + defaults

- [ ] **Add Caddy operational toggles to config**
  - **Files**
    - `/home/lazypanda/Documents/LibreLoom/LibreServ/server/backend/internal/network/types.go` (`network.CaddyConfig`)
    - `/home/lazypanda/Documents/LibreLoom/LibreServ/server/backend/internal/config/config.go` (`config.CaddyConfig`)
    - `/home/lazypanda/Documents/LibreLoom/LibreServ/server/backend/configs/libreserv.yaml` (defaults + docs comments)
  - **Suggested fields**
    - `enabled: bool` (or `mode: "enabled" | "noop" | "disabled"`)
    - `reload: { retries: int, backoff_min: duration, backoff_max: duration, jitter: float }`
    - `logging: { output: "stdout"|"stderr"|"file", file: string, format: "console"|"json", level: string }`
    - `acme: { enabled: bool, mode: "http-01"|"dns-01", dns_provider: string, dns_env: map, email_override: string, poll_timeout: duration }`
- [ ] **Decide config precedence**
  - Admin API vs CLI vs noop
  - When `admin_api` is set but unreachable: retry then fallback (or fail fast depending on config)

## 2) Caddy reload hardening (Admin API preferred, with retries/backoff)

- [ ] **Centralize reload logic behind one “reload strategy”**
  - **Files**
    - `/home/lazypanda/Documents/LibreLoom/LibreServ/server/backend/internal/network/caddy.go` (`(*CaddyManager).reloadCaddy`)
  - **Behavior**
    - Try Admin API `POST /load` first (preferred)
    - Retry `POST /load` with exponential backoff + jitter on transient errors (network errors, 502/503, timeouts)
    - If retries exhausted: optionally fallback to `caddy reload --config ...` (if enabled)
    - Return structured error text including: method tried, status code, response body (when present)
- [ ] **Make reload idempotent and safe**
  - Ensure file read errors / missing config path are surfaced clearly
  - Include request timeout controls (client timeout and per-attempt context)

## 3) Configurable Caddy logging output (Caddyfile template)

- [ ] **Stop hardcoding `log { output stdout }`**
  - **Files**
    - `/home/lazypanda/Documents/LibreLoom/LibreServ/server/backend/internal/network/caddy.go` (`generateCaddyfile` template)
  - **Implementation**
    - Template log block based on config:
      - stdout/stderr
      - file output (create directory, set permissions expectations)
      - optional JSON format
- [ ] **Document log behavior + defaults**
  - Where logs go in dev vs production

## 4) No-op / disabled mode when Caddy is missing

- [ ] **Introduce a “Caddy disabled/noop” execution path**
  - **Files**
    - `/home/lazypanda/Documents/LibreLoom/LibreServ/server/backend/internal/network/caddy.go`
    - API handlers that call into Caddy (routes + ACME)
  - **Expected behavior**
    - Route CRUD can still update DB/in-memory state
    - Config generation can still run (optional)
    - Reload/issue operations become **no-op** with a clear response:
      - Either return success with `warning: "caddy disabled"`
      - Or return `409/412` “feature disabled” depending on API design
- [ ] **Ensure “Caddy missing” doesn’t brick setup**
  - `GetStatus` should clearly indicate “disabled/noop” rather than “unknown error”

## 5) Expose errors to API callers (reduce silent failure)

- [ ] **Make route creation/update/delete return reload failure context**
  - **Files**
    - `/home/lazypanda/Documents/LibreLoom/LibreServ/server/backend/internal/api/handlers/network.go`
    - `/home/lazypanda/Documents/LibreLoom/LibreServ/server/backend/internal/network/caddy.go`
  - **Notes**
    - Right now route creation triggers reload during `AddRoute` and returns error, which is good.
    - But background ACME issuance in `CreateRoute` uses a goroutine and drops the error.
- [ ] **Fix “fire-and-forget” ACME issuance**
  - Option A (simpler): remove goroutine and do issuance synchronously when requested
  - Option B (better UX): create an “ACME job” model:
    - `POST /acme/request` returns job id
    - `GET /acme/jobs/{id}` returns status + errors + timestamps
    - Persist job results in DB

## 6) Replace “reload Caddyfile to trigger ACME” with a real cert lifecycle

- [ ] **Pick an approach**
  - **Approach A: Native Caddy automation via Admin API (JSON config)**
    - Manage automation policies for HTTP-01 and DNS-01
    - Query cert status from Caddy endpoints (or logs/metrics)
  - **Approach B: External ACME client (e.g., `acme.sh` / lego)**
    - LibreServ drives challenge presentation (DNS API)
    - Store certs where Caddy can read them
    - Reload Caddy after cert write/update
- [ ] **DNS-01 support**
  - Define required provider config (provider name + env vars/credentials)
  - Add validation: “DNS provider configured” before allowing DNS-01 issuance
  - Add “cleanup” for temporary DNS records if you manage them directly
- [ ] **Lifecycle endpoints**
  - `POST /api/v1/network/acme/request` (create order/job)
  - `GET /api/v1/network/acme/status?domain=...` (issued/pending/failed + reason)
  - `POST /api/v1/network/acme/renew` (optional)
  - `DELETE /api/v1/network/acme/routes/{routeID}` already exists—decide final cleanup semantics

## 7) Tests (minimum viable)

- [ ] **Reload retries/backoff**
  - Use `httptest.Server` to simulate:
    - transient 502/503 then success
    - timeouts then success
    - permanent failure returns useful error
- [ ] **No-op mode**
  - Verify route CRUD works without `caddy` binary and without `admin_api`
  - Verify reload/issue returns expected noop response
- [ ] **ACME request flow**
  - Verify `RequestCert` adds/removes `acme-auto` route as expected
  - Verify error propagation behavior is consistent (no silent failures)

## 8) Docs / operator guidance

- [ ] **Update README / docs**
  - How to configure Admin API
  - How to enable DNS-01 (provider, env, permissions)
  - Where logs go + recommended production setup
  - What “noop/disabled” means (and why)

## 9) Nice-to-have follow-ups

- [ ] Add structured error types for reload/issue (`ErrCaddyDisabled`, `ErrAdminUnreachable`, `ErrReloadRejected`, etc.)
- [ ] Add metrics counters (reload attempts, reload failures, issuance failures)
- [ ] Add audit log entries for “issued cert”, “failed issuance”, “route created for acme-auto”
