# LibreServ

Self-hosting platform that aims to make running your own server “plug it in and it works”.

## Status
- In active development (MVP target: April 30, 2026)
- Backend is Go; Frontend is React/Vite. Reverse proxy is Caddy. Database is SQLite. Apps run via Docker.

## What’s here
- **Backend** (`server/backend`): API server, app installer/manager, monitoring, backups, support session tooling.
- **Frontend** (`server/frontend`): Vite/React source (not built by default). Build output should be copied/served from `server/backend/OS/dist/` (ignored in git).
- **Built-in apps**: Nextcloud AIO, SearXNG, Ollama, ConvertX compose templates live under `server/backend/apps/builtin/`.
- **CI**: `.github/workflows/backend-test.yml` runs `go test ./...` for the backend.
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

## Notes
- Caddy must be installed/configured if you want automatic HTTPS; otherwise set the network config appropriately.
- Secrets (JWT/CSRF) are auto-generated and persisted to the config file on first run; ensure the config path is writable or provide secrets via env.
- ThePlan.md contains a longer product/architecture brain dump.

## License
AGPL 3.0. See LICENSE.
