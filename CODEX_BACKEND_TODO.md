# Backend Hardening TODO

- Caddy/ACME: prefer admin API reload with retries/backoff; configurable log target; optional no-op mode when Caddy absent; expose errors to API callers; support DNS-01/real cert lifecycle instead of “reload Caddyfile”.
- Secret policy: allow env-only secrets or writable config; fail fast when config is read-only; document behavior.
- Backups: implement database restore flow; enforce checksum verification by default; consider encryption and retention policies.
- Monitoring: add a disabled mode when Docker is unavailable; improve container matching (compose project labels); close Docker client cleanly; graceful degrade in API.
- CI: add GitHub Actions to run `go test ./...` with module caching and lint hook placeholder.
- App catalog hardening:
  - Pin images to stable tags and document update cadence.
  - Avoid port collisions (dynamic assignment or reverse-proxy mapping).
  - SearXNG base URL should be templated for reverse proxy; ensure health path is valid.
  - Nextcloud AIO avoids direct `/var/run/docker.sock` bind (use socket proxy or alternative).
  - Ollama GPU settings: ensure compose works without swarm; consider `runtime: nvidia`/device requests.
  - Tighten CORS defaults (Ollama/ConvertX) from `*` unless explicitly set.
- Project goals: add SSO/IdP integration and feature-matrix endpoints; cloud backup/relay/AI helper wiring.
- Added manually by @plainskill: Let's create the missing backend tests as well!
