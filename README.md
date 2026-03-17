# LibreServ

Taking back your privacy shouldn't require a degree in networking. LibreServ is on a mission to decouple your data from large companies like Google and Microsoft by creating a home server experience that is powerful enough for experts, yet simple enough for everyone else.

## Target Audience

General users. No person who isn't completely uninitiated in terms of tech shouldn't be able to use LibreServ.

The primary method of delivery for LibreServ will likely be via hardware with the software pre-installed.

## Status
- In active development (MVP target: April 30, 2026)
- Backend is Go; Frontend is React/Vite. Reverse proxy is Caddy. Database is SQLite. Apps run via Docker.

## Goals
- 99% of users shouldn't need a terminal; actions should be reversible and plain-language.
- Ship opinionated defaults for Caddy/HTTPS, monitoring, backups, and a small curated app set (quality over quantity).

## MVP Definition

LibreServ has achieved MVP when ALL of the following are true:

### First-Run Experience
- [ ] A user can setup the hardware shipped with LibreServ with no technical help
- [ ] Setup wizard guides user through creating admin account
- [ ] Preflight checks verify Docker, disk space, database before first use

### App Management
- [ ] A user can install any app from the catalog without difficulty
- [ ] User sees plain-language warnings about app features (shared account, external auth)
- [ ] User can start, stop, and restart installed apps
- [ ] User can uninstall apps with confirmation

### Backups
- [ ] User can create backups of any installed app
- [ ] User can restore from an existing backup
- [ ] User can configure automatic cloud backups (Backblaze B2 or S3)

### Remote Access
- [ ] User can configure a domain for remote access
- [ ] HTTPS is automatically configured and renewed
- [ ] User can add custom domain routes to apps

### System
- [ ] User can check system health and resource usage
- [ ] User can add and manage multiple users
- [ ] User can update LibreServ from the web UI

---

## What’s here
- **Backend** (`server/backend`): API server, app installer/manager, monitoring, backups, support session tooling.
- **Frontend** (`server/frontend`): Vite/React source (not built by default). Build output should be copied/served from `server/backend/OS/dist/` (ignored in git).
- **Built-in apps**: Nextcloud AIO, SearXNG, Ollama, ConvertX, MotionEye compose templates live under `server/backend/apps/builtin/`.
- **CI**: `.github/workflows/ci.yml` runs backend vet/tests and frontend lint/build on pushes/PRs.

## Contributing

**Developers:** See [ROADMAP.md](ROADMAP.md) for the task list organized by user journey.

Start with [T1.1.1: Setup Wizard Page](ROADMAP.md#t111-create-setup-wizard-page) - the most critical missing piece for MVP.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution workflow.

## Quick start
```bash
cd server/frontend
npm install
cd ..
./libreserv.sh setup
```

## Frontend build
Build output should be copied/served from `server/backend/OS/dist/` (ignored in git).
If `.gz` assets exist alongside files in `OS/dist`, LibreServ will serve them when clients send `Accept-Encoding: gzip`.
For embedded release binaries, build with:
```bash
cd server/backend
make frontend-build
BUILD_TAGS=embedfront make build
```

## To setup login

### Option 1: Using libreserv.sh (recommended)
```bash
./libreserv.sh adduser "username" "password" "email@example.com"
```

### Option 2: Using setup-admin.sh (for development)
If running the backend directly without the frontend:
```bash
cd server/backend
./setup-admin.sh
```
This will create an admin user with username `admin` and password `hunter2hunter2`.

Or manually via API:
```bash
# Complete initial setup
curl -X POST http://localhost:8080/api/v1/setup/complete \
  -H "Content-Type: application/json" \
  -d '{"admin_username":"admin","admin_password":"hunter2hunter2","admin_email":"admin@example.com"}'

# Then login
curl -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"hunter2hunter2"}'
```

## To run
```bash
./libreserv.sh run frontend ./server/frontend backend ./server/backend
```

## To get status
```bash
./libreserv.sh status
```

## To stop
```bash
./libreserv.sh stop
```

`./libreserv.sh help` for more.

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

## Contribute / Support
- Issues and PRs welcome. CI runs Go vet/tests and frontend lint/build.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.
- See [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) for development setup and testing.
- Donate: https://ko-fi.com/libreloom

## License
AGPL 3.0. See LICENSE.
