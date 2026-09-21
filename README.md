# LibreServ

A home server that is powerful enough for experts and simple enough for everyone else. The goal is to keep your data off Google and Microsoft without needing a degree in networking.

LibreServ is meant to ship on hardware with the software already installed. **99% of users should never need a terminal.**

## Status

Active development. Go backend, React/Vite frontend, Caddy reverse proxy, SQLite, apps via Podman.

MVP is a non-technical user walking setup → install an app → backup → restore without a terminal. Live checklist: [GOALS.md](sol/GOALS.md).

## What's here

- **Backend** (`sol/server/backend`) — API, app lifecycle, monitoring, backups
- **Frontend** (`sol/server/frontend`) — Vite/React; production build goes in `sol/server/backend/OS/dist/` (gitignored)
- **App catalog** — templates from `sol/server/backend/apps/` on disk (empty here); curated apps will live in a separate repo ([GOALS.md](sol/GOALS.md))
- **Luna** (`luna/`) — Ethernet-only file box (`lunad` + web). No setup Wi-Fi access point.
- **CI** — `./ci` (backend tests + frontend lint/build)

## Install (from a release)

```bash
curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/sol/install.sh -o install.sh && sudo bash install.sh && rm install.sh
```

For a specific tag (non-interactive), use `/raw/tag/<version>/sol/install.sh` instead. [Releases](https://gt.plainskill.net/LibreLoom/LibreServ/releases).

## Development

```bash
# Terminal 1
cd sol/server/backend && make run

# Terminal 2
cd sol/server/frontend && npm install && npm run dev
```

First-time admin (dev, no UI): `cd sol/server/backend && ./setup-admin.sh` (`admin` / `hunter2hunter2`).

Embedded release binary: `cd sol/server/backend && make frontend-build && BUILD_TAGS=embedfront make build`.

Needs: Podman + `podman-compose`. Copy `sol/server/backend/configs/libreserv.yaml.example` → `sol/server/backend/configs/libreserv.yaml`. Empty JWT/CSRF secrets are generated and written to the config file; if the file is read-only, set `LIBRESERV_AUTH_JWT_SECRET` and `LIBRESERV_AUTH_CSRF_SECRET`. Caddy/HTTPS: [AGENTS.md](AGENTS.md).

## Contributing

[GOALS.md](sol/GOALS.md) is what we are building. [CONTRIBUTING.md](CONTRIBUTING.md) is the workflow. Push access → `main`; otherwise open a PR. Donate: https://ko-fi.com/libreloom

## License

AGPL 3.0. See [LICENSE](LICENSE). Luna can optionally load third-party AGPL
components (EuroOffice) that are never committed to this repo — see
[luna/docs/THIRD_PARTY_EUROOFFICE.md](luna/docs/THIRD_PARTY_EUROOFFICE.md).
