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
