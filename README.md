# LibreServ

A home server that is powerful enough for experts and simple enough for everyone else. The goal is to keep your data off Google and Microsoft without needing a degree in networking.

LibreServ is meant to ship on hardware with the software already installed. **99% of users should never need a terminal.**

## Status

Active development. Go backend, React/Vite frontend, Caddy reverse proxy, SQLite, apps via Podman.

MVP is a non-technical user walking setup → install an app → backup → restore without a terminal. Live checklist: [GOALS.md](GOALS.md).

## What's here

- **Backend** (`server/backend`) — API, app lifecycle, monitoring, backups
- **Frontend** (`server/frontend`) — Vite/React; production build goes in `server/backend/OS/dist/` (gitignored)
- **App catalog** — templates from `apps/` on disk; curated apps will live in a separate repo ([GOALS.md](GOALS.md))
- **CI** — `./ci` (backend tests + frontend lint/build)

## Install (from a release)

```bash
curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/install.sh -o install.sh && sudo bash install.sh && rm install.sh
```

For a specific tag (non-interactive), use `/raw/tag/<version>/install.sh` instead. [Releases](https://gt.plainskill.net/LibreLoom/LibreServ/releases).

## Development

```bash
# Terminal 1
cd server/backend && make run

# Terminal 2
cd server/frontend && npm install && npm run dev
```

First-time admin (dev, no UI): `cd server/backend && ./setup-admin.sh` (`admin` / `hunter2hunter2`).

Embedded release binary: `cd server/backend && make frontend-build && BUILD_TAGS=embedfront make build`.

Needs: Podman + `podman-compose`. Copy `configs/libreserv.yaml.example` → `configs/libreserv.yaml`. Empty JWT/CSRF secrets are generated and written to the config file; if the file is read-only, set `LIBRESERV_AUTH_JWT_SECRET` and `LIBRESERV_AUTH_CSRF_SECRET`. Caddy/HTTPS details: [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md).

## Contributing

[GOALS.md](GOALS.md) is what we are building. [CONTRIBUTING.md](CONTRIBUTING.md) is the workflow. Push access → `main`; otherwise open a PR. Donate: https://ko-fi.com/libreloom

## License

AGPL 3.0. See [LICENSE](LICENSE).
