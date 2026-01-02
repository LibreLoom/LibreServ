# LibreServ

[![CI](https://gt.plainskill.net/LibreLoom/LibreServ/actions/workflows/ci.yml/badge.svg?branch=main)](https://gt.plainskill.net/LibreLoom/LibreServ/actions/workflows/ci.yml)

Self-hosting platform that aims to make running your own server “plug and play”.

## Status
- In active development (MVP target: April 30, 2026)
- Backend is Go; Frontend is React/Vite. Reverse proxy is Caddy. Database is SQLite. Apps run via Docker.

## Goals
- 95% of users shouldn’t need a terminal; actions should be reversible and plain-language.
- Ship opinionated defaults for Caddy/HTTPS, monitoring, backups, and a small curated app set (quality over quantity).

## What’s here
- **Backend** (`server/backend`): API server, app installer/manager, monitoring, backups, support session tooling.
- **Frontend** (`server/frontend`): Vite/React source (not built by default). Build output should be copied/served from `server/backend/OS/dist/` (ignored in git).
- **Built-in apps**: Nextcloud AIO, SearXNG, Ollama, ConvertX compose templates live under `server/backend/apps/builtin/`.
- **CI**: `.github/workflows/ci.yml` runs backend vet/tests and frontend lint/build on pushes/PRs.
- **TODO**: `CODEX_BACKEND_TODO.md` tracks hardening work (Caddy/ACME, SSO, app catalog pins, etc.).

## Quick start (backend)
```bash
cd server/backend
go test ./...              # run unit tests
go build ./cmd/libreserv   # build binary
./libreserv serve --config ./configs/libreserv.yaml  # run (adjust config path)
```

## Frontend build
The backend serves static assets from `server/backend/OS/dist/` (ignored in git). To build the current frontend:
```bash
cd server/frontend
npm install
npm run build
cp -r dist ../backend/OS/dist
```
Then restart the backend to serve the new assets.
If `.gz` assets exist alongside files in `OS/dist`, LibreServ will serve them when clients send `Accept-Encoding: gzip`.
For embedded release binaries, build with:
```bash
cd server/backend
make frontend-build
BUILD_TAGS=embedfront make build
```

## Notes
- Caddy must be installed/configured if you want automatic HTTPS; otherwise set `network.caddy.mode` to `noop` or `disabled`.
- Caddy reloads via Admin API use retries/backoff (see `network.caddy.reload.*` in `server/backend/configs/libreserv.yaml`).
- ACME issuance is tracked via jobs: `POST /api/v1/network/acme/request`, then poll `GET /api/v1/network/acme/status?domain=...` (or `GET /api/v1/network/acme/jobs/{jobID}`).
- Docker must be installed with the Compose v2 plugin (`docker compose`).
- Secrets (JWT/CSRF) policy:
  - If `auth.jwt_secret` and `auth.csrf_secret` are set (via config file or env), LibreServ uses them as-is.
  - If either secret is missing at startup, LibreServ will generate secure values and **persist them to the config file**.
  - If the config file path is **read-only**, startup fails fast with a clear error; in that case set env vars:
    - `LIBRESERV_AUTH_JWT_SECRET`
    - `LIBRESERV_AUTH_CSRF_SECRET`
- ThePlan.md contains a longer product/architecture brain dump.

## Contribute / Support
- Issues and PRs welcome. CI runs Go vet/tests and frontend lint/build.
- Donate: https://ko-fi.com/libreloom

## License
AGPL 3.0. See LICENSE.
