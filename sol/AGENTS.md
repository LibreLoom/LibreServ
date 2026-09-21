# AGENTS.md - sol (LibreServ)

LibreServ is the home-server product: Go backend + React frontend + LibreServ
Connect cloud companion + installer/ISO bits. Global rules (plain language,
design system, frontend conventions, git/forge rules) live in the repo-root
`AGENTS.md` — they apply here too.

## Layout

```
sol/
├── server/backend/           # Go 1.26 backend (chi/v5 router)
│   ├── cmd/libreserv/        # Entry point
│   ├── internal/
│   │   ├── api/              # HTTP handlers + middleware + router
│   │   │   ├── handlers/     # Endpoint handlers
│   │   │   │   └── response.go # JSONError, JSONResponse helpers
│   │   │   ├── middleware/   # Auth, CORS, CSRF, rate-limit, security headers
│   │   ├── apps/             # App lifecycle + catalog
│   │   ├── auth/             # JWT authentication
│   │   ├── database/         # SQLite + migrations (internal/database/migrations/)
│   │   ├── podman/           # Container runtime (Podman) integration
│   │   ├── network/          # Caddy, ACME, DNS providers, DDNS
│   │   ├── storage/          # Backup service (restic + tar fallback)
│   │   ├── jobqueue/         # Background jobs
│   │   ├── wifi/             # LibreServ setup hotspot (hostapd+dnsmasq)
│   │   └── jobs/             # Simple time-based scheduler
│   ├── configs/              # YAML config (must copy .example → .yaml before run)
│   ├── apps/                 # App catalog (repo apps loaded from disk; currently empty — curated catalog will be a separate repo)
│   ├── OS/dist/              # Frontend build output (gitignored)
│   └── Makefile
│
├── server/frontend/          # React 19 + Vite 7 + Tailwind 4
│   └── src/
│       ├── pages/            # Route pages (.jsx, NOT .tsx)
│       ├── hooks/            # Custom hooks (useAuth, useApps, etc.)
│       ├── context/          # AuthContext, ThemeContext, ToastContext
│       ├── components/       # UI components
│       └── index.css         # Theme variables + Tailwind config
│
├── connect/                  # LibreServ Connect — cloud SaaS (independent Go 1.26
│                             # module, chi/v5 API, SQLite, Stripe billing). Provides
│                             # external services to LibreServ devices: email relay,
│                             # DNS/domain, cloud backups, tunnel access, AI inference,
│                             # human support. Own configs, admin API, device API.
│
├── iso/                      # kiosk service + setup-code generator
├── install.sh                # public installer — URL is load-bearing
├── install-lib/              # installer helpers
├── Dockerfile                # all-in-one image (build context = repo root)
└── entrypoint.sh
```

## Build & Run

### Backend
```bash
cd sol/server/backend
cp configs/libreserv.yaml.example configs/libreserv.yaml   # Required first time
make build                                    # → bin/libreserv
make run                                      # Build + run with LIBRESERV_INSECURE_DEV=true
make test                                     # All unit tests
make lint                                     # gofmt check + go vet
make security                                 # govulncheck + gosec + staticcheck
make frontend-build                           # Install + build frontend to OS/dist/
BUILD_TAGS=embedfront make build              # Binary with embedded frontend
make restic-fetch                             # Download restic binary for backups
```

### Frontend
```bash
cd sol/server/frontend
npm install
npm run dev                                   # Dev server on port 3000 (not default 5173)
npm run build                                 # Production build → ../backend/OS/dist/
npm run lint
npm run typecheck                             # TypeScript checking (yes, on .jsx files)
npm test                                      # Vitest (not Jest)
npm run scan:colors                           # Detect hardcoded colors in UI code
```

### LibreServ Connect (cloud SaaS module)
```bash
cd sol/connect
cp configs/connect.yaml.example configs/connect.yaml   # Required first time
make build                                    # → bin/connect-server
make run                                      # Build + run
make test                                     # Unit tests
make lint                                     # gofmt + go vet
```
Env prefix: `CONNECT_` (viper), e.g. `CONNECT_SERVER_PORT`, `CONNECT_AUTH_ADMIN_TOKEN_SECRET`.

## Go

- Module path: `gt.plainskill.net/LibreLoom/LibreServ`
- Router: `github.com/go-chi/chi/v5` (not gin)
- Error response: `JSONError(w, statusCode, message)` — dot-imported from `internal/api/response`
- Auth context: `middleware.GetUser(ctx)` returns `*middleware.User`, `middleware.GetUserID(ctx)` returns `(string, bool)`
- Env var prefix: `LIBRESERV_` (viper), e.g. `LIBRESERV_SERVER_PORT`, `LIBRESERV_AUTH_JWT_SECRET`
- Run `go fmt` before commit; `go vet` must pass
- Integration tests: build tag `integration`, require Podman:
  ```bash
  go test -v -tags=integration ./tests/integration/...
  ```
- Race detector: `make test-race` targets middleware, auth, jobqueue only

## Testing

### Backend
```bash
cd sol/server/backend
go test ./...                                          # All unit tests
go test -v -run TestName ./internal/apps               # Specific test
go test -race ./internal/auth                           # Race detector
go test -coverprofile=coverage.out ./cmd/... ./internal/...  # Coverage
```

### Frontend
```bash
cd sol/server/frontend
npm test                                               # All tests
npm test -- src/hooks/useAuth.test.jsx                 # Single file
npm test -- --coverage                                 # With coverage
npm test -- --watch                                    # Watch mode
```

## Common Tasks

**New API endpoint:**
1. Create handler in `internal/api/handlers/{resource}.go`
2. Add route in `internal/api/router.go` (not server.go — routes live in router.go)
3. Write test in `{resource}_test.go`

**New frontend page:**
1. Create `src/pages/{PageName}.jsx`
2. Add lazy-loaded route in `src/App.jsx`

**Reset dev data:**
```bash
rm -rf sol/server/backend/dev/data sol/server/backend/dev/apps sol/server/backend/dev/logs
```

## Key Notes

- **Database:** SQLite. Migrations in `internal/database/migrations/` are squashed into one `001_schema.sql`; `migrate.go` reconciles old numbered migrations on existing DBs
- **Container Runtime:** Required for app runtime (`podman compose`). Integration tests also need Podman.
- **Config:** `server/backend/configs/libreserv.yaml` — must be created from `.example` before first run
- **Secrets:** If `jwt_secret`/`csrf_secret` are empty at startup, LibreServ generates and persists them to the config file. If config is read-only, set `LIBRESERV_AUTH_JWT_SECRET` / `LIBRESERV_AUTH_CSRF_SECRET` env vars instead.
- **Frontend build output:** `server/backend/OS/dist/` (gitignored). Production binaries with embedded frontend: `BUILD_TAGS=embedfront make build`
- **Restic:** Backup system requires restic binary. `make restic-fetch` downloads it; `embedrestic` build tag bundles it in the binary.
- **Caddy:** Reverse proxy for HTTPS. Mode can be `enabled`/`noop`/`disabled` in config. ACME certs via DNS-01 challenge.
- **No `libreserv.sh`** in repo — use `make run` from `server/backend/` for development instead
- **Connect module:** `gt.plainskill.net/LibreLoom/LibreServConnect` — independent Go module in `sol/connect/`. It has its own chi/v5 router, SQLite database, config (env prefix `CONNECT_`), and admin/device APIs. Not part of the main backend binary.
- **Setup hotspot (LibreServ only):** If setup isn't finished and there's no cable or home Wi-Fi, LibreServ briefly broadcasts an open network named "LibreServ Setup" (`internal/wifi` hostapd+dnsmasq). A phone joins that network, opens the wizard, and the hotspot stops once the box is online. **Luna has no setup AP** — Ethernet cable only (`luna/crates/lunad/src/hotspot.rs` is a stub that never starts).
- **LibreServ is WAN-accessible by design** once a domain is configured — the auth endpoints (`/auth/login`, `/auth/password-reset/*`, `/auth/invite/{token}`) are internet-exposed, not LAN-only. There is no public `/auth/register`. Center this in every auth/security decision: the primary defenses are strong passwords + rate limiting + 2FA, **not captchas** (captcha is decided against for v1). Prefer admin-invited users over open public registration.

## Frontend Components

- **`components/ui/` primitives** — the standardized building blocks. Pages and components must use these instead of hand-rolled equivalents, so one change propagates across the whole UI:
  - **Button** (`src/components/ui/Button.jsx`) — the canonical button. Read its doc comment before use: variants `primary` (main action on cards), `secondary` (main action on page bg), `accent` (form/modal submit), `danger` (destructive), `outline` (cancel/back), `ghost` (icon-only). The `surface` prop names the BACKDROP the button sits on (`"primary"` = page bg, `"secondary"` = card, the default); outline/ghost chrome contrasts automatically. Use `loading` for pending states, `fullWidth` instead of `w-full`, and `asChild` to style a `Link`/`<a>` as a button. Never hand-roll pill buttons or pill-styled links.
  - **Page** (`src/components/ui/Page.jsx`) — the standard page shell (`bg-primary text-secondary`, skip-link target, optional HeaderCard title). Every routed content page uses it (full-screen flows like Login/Setup are the exception).
  - **Card / ModalCard / HeaderCard** (`src/components/cards/`) — surfaces. `bg-secondary text-primary` by default; `surface="primary"` inverts.
  - **HeaderCard auto-splits when chrome does not fit.** It prefers a single one-line pill; when `leftContent`/`rightContent` cannot fit beside the title, it measures overflow and stacks separate cards (title, then sides). Do not put navigation or back links in the header — use the bottom navbar (`Navbar` — desktop pill + mobile FAB/dialog; Luna mirrors LibreServ). Put taglines in Page `bottomContent` (renders below the header, not inside it). Keep Luna and LibreServ `HeaderCard`/`Page` copies in sync.
  - **Tooltip** (`src/components/ui/Tooltip.jsx`, same file in Luna web) — `InfoHint` (ⓘ, longer aside) and `TermHint` (dotted underline on a word). Hover, focus, and tap. Do not use native `title=` for new glosses. Keep Luna and LibreServ copies in sync.
- **Dropdown** — Always use the project's `Dropdown` component (`src/components/common/Dropdown.jsx`) instead of a raw `<select>`. It accepts `options` as `Array<{value: string, label: string}>`, supports `fullWidth`, `bg` ( `"primary"` | `"secondary"`), and `onChange(value: string)`.
- **Haptics** — `src/utils/haptics.js` (`haptic()` with presets `selection`, `light`, `medium`, `heavy`, `rigid`, `soft`, `success`, `warning`, `error`, `nudge`) is wired into Button/Toggle/SegmentedControl/Dropdown — do not sprinkle it through pages. The user toggle lives in Settings → Appearance.
- **Model fetch endpoint** — `POST /settings/ai-support/models` (admin-only) accepts `{ base_url, api_key }` and returns `{ models: [] }` fetched live from the provider. Use this to populate model Dropdowns in AI config modals.
- **ChatHeader crash guard** — `ChatHeader`'s `ModelPill` must guard against empty `modelOptions` (e.g. `resolvedModelOptions[0]?.value || ""`), because `chat.models` starts empty before `loadModels` resolves.
