# LibreServ Monorepo

This place is all code. If you're just interested in the product, and not the code, visit [the website instead](https://serv.libreloom.org).

Two products plus shared glue live here:

| Path | What it is | Stack |
|------|------------|-------|
| `sol/` | **LibreServ Sol** — the home server (development currently stalled) | Go 1.26 (chi/v5) API, React 19 + Vite 7 + Tailwind 4, SQLite, Podman |
| `sol/connect/` | **LibreServ Connect** — cloud companion (independent Go module) | Go 1.26, chi/v5, SQLite, Stripe |
| `luna/` | **LibreServ Luna** — the file box | Rust `lunad` + `luna-core`, React/Vite web, GTK 4 desktop, native Android app, Debian OS image |
| `luna/connect/` | **Luna Connect** — cloud companion (independent Go module) | Go 1.26, SQLite, Stripe |
| `shared/ui/` | `@libreloom/ui` — shared design-system components | React 19, consumed as a `file:` dependency by both web apps |
| `infra/` | CI runner, release pipeline, repo automation bots | Go + shell |
| `keys/` | Release minisign **public** keys (lunad fetches these over HTTP — do not move) | — |

```
LibreServ/
├── sol/            # LibreServ Sol + LibreServ Connect + installer/ISO bits
├── luna/           # Luna daemon, web, desktop, mobile, OS, Luna Connect
├── shared/ui/      # @libreloom/ui — edit shared components HERE, never fork them back
├── infra/          # ./ci runner source, bots, release docs
├── ci              # CI launcher (stays at repo root)
├── release.sh      # release pipeline (both products)
└── keys/           # public minisign keys
```

Each area has its own `AGENTS.md` with the detailed rules; the
[root `AGENTS.md`](AGENTS.md) covers conventions that apply everywhere
(design system, plain-language copy, git/forge rules). Read the one for the
area you are touching before you touch it.

## Prerequisites

- **Go 1.26+** — Sol, Connect
- **Node 20+ and npm** — both web UIs
- **Rust (edition 2024) and Cargo** — Luna
- **Podman + `podman-compose`** — app runtime for Sol, and all `./ci` runs
- Optional: `adb` for the Android app, GTK 4/libadwaita dev packages for the desktop app

## Run the stack

### LibreServ Sol

```bash
# Terminal 1 — API on :8080
cd sol/server/backend
cp configs/libreserv.yaml.example configs/libreserv.yaml   # required first time
make run                                                    # sets LIBRESERV_INSECURE_DEV=true

# Terminal 2 — UI on :3000
cd sol/server/frontend
npm install
npm run dev                                                 # proxies /api and /health to :8080
```

First run: open <http://localhost:3000> and complete the setup wizard to create
the admin user. Empty `jwt_secret`/`csrf_secret` values are generated and
written back to the config file; if the config is read-only, set
`LIBRESERV_AUTH_JWT_SECRET` / `LIBRESERV_AUTH_CSRF_SECRET` instead.

To reset dev data: `rm -rf sol/server/backend/dev/{data,apps,logs}`.

Embedded release-style binary (frontend baked in):

```bash
cd sol/server/backend
make frontend-build
BUILD_TAGS=embedfront make build     # → bin/libreserv
```

### LibreServ Luna

```bash
# Terminal 1 — lunad on :8090, rebuilds on save
cd luna
make daemon-dev

# Terminal 2 — web UI on :3001
cd luna/web
npm install
npm run dev
```

Other entry points: `make desktop-dev` (GTK app with auto sign-in),
`make mobile-dev` (Android `installDebug` + relaunch on save, needs `adb`),
`make companion-dev` (prints the full three-terminal recipe). For Connect-backed
features locally, the mock cluster lives in `luna/scripts/mocks/`:
`luna/scripts/mocks/seed-mock-connect.sh` starts it, and
`make -C luna mock-connect ARGS="status"` inspects it.

### Cloud companions (Connect)

```bash
# LibreServ Connect
cd sol/connect
cp configs/connect.yaml.example configs/connect.yaml
make test
make run

# Luna Connect
cd luna/connect
cp configs/luna-connect.yaml.example configs/luna-connect.yaml
make test
make run
```

Config env prefixes: `CONNECT_` for LibreServ Connect, `LUNACONNECT_` for Luna
Connect. Neither module is part of the Sol or Luna binaries.

## Tests and lint

Run the checks before you push — `@fluffy-bunny-23`, lord of CI, does not accept
excuses.

```bash
./ci                              # interactive TUI; picks tests for your changes
./ci run -profile libreserv       # Sol release gate: backend + frontend, no Luna
./ci run -profile luna            # Luna only (Rust, web, desktop, mobile)
./ci run -profile full            # everything
```

`./ci` is a local Go runner that executes tests in Podman containers (no Docker,
no GitHub Actions). It rebuilds itself when `infra/ci-source/*.go` changes.

Per-area quick checks:

```bash
cd sol/server/backend && make lint && make test     # gofmt + go vet, unit tests
cd sol/server/frontend && npm run lint && npm run typecheck && npm test
cd luna && make lint && make test
```

Integration tests need Podman and the `integration` build tag:

```bash
cd sol/server/backend && go test -v -tags=integration ./tests/integration/...
```

## Releases

`./release.sh` is the shared release ritual. Tags are per product and **must not
be mixed**: `v*` = LibreServ, `luna-v*` = Luna, and `connect-v*` /
`luna-connect-v*` are used by the cloud services' own deploy flow. The full
process is in [`infra/docs/RELEASE.md`](infra/docs/RELEASE.md).

Git tags do not sync across forges via the mirror — push release tags to the
forge the consumer actually fetches.

## Contributing

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the workflow (push access → `main`;
  everyone else → fork, branch, PR).
- [`AGENTS.md`](AGENTS.md) — conventions, design system, and the plain-language
  rules for anything a user reads.
- [`sol/GOALS.md`](sol/GOALS.md) — what we are actually building.

Conventional commits (`feat(scope): …`, `fix(scope): …`); branch names are
`feat/…`, `fix/…`, `docs/…`, `chore/…`. Commits pushed to one forge are mirrored
to the others — push once.

Found a vulnerability? See [`SECURITY.md`](SECURITY.md) instead of opening a
public issue.

## License

AGPL 3.0 — see [`LICENSE`](LICENSE). Luna can optionally load third-party AGPL
components (EuroOffice) that are never committed to this repo; see
[`luna/docs/THIRD_PARTY_EUROOFFICE.md`](luna/docs/THIRD_PARTY_EUROOFFICE.md).
