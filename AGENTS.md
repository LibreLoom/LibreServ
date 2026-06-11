# AGENTS.md - LibreServ Codebase Guide

## Quick Reference

| Command | Description |
|---------|-------------|
| `./ci` | Interactive CI runner (auto-builds if needed) |
| `./ci run -profile full` | Run full CI suite non-interactively |
| `cd server/backend && make lint` | Format check + vet Go code |
| `cd server/frontend && npm run lint && npm run typecheck` | Lint + typecheck frontend |

---

## Architecture

```
LibreServ/
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
│   │   ├── docker/           # Container runtime (Podman) integration
│   │   ├── network/          # Caddy, ACME, DNS providers, DDNS
│   │   ├── storage/          # Backup service (restic + tar fallback)
│   │   ├── jobqueue/         # Background jobs
│   │   └── jobs/             # Simple time-based scheduler
│   ├── configs/              # YAML config (must copy .example → .yaml before run)
│   ├── apps/builtin/         # App templates (7 apps: nextcloud, searxng, ollama, convertx, motioneye, homeassistant, librechat)
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
├── e2e-tests/                # Playwright E2E tests
├── connect/                  # Cloud SaaS companion (LibreServ Connect). Independent Go 1.26 module
│                             # with chi/v5 API, SQLite, Stripe billing. Provides external services to
│                             # LibreServ devices: email relay, DNS/domain, cloud backups, tunnel access,
│                             # AI inference, and human support. Has its own configs, admin API, and device API.
├── companion/                # BLE companion apps for accessing LibreServ when Wi-Fi is unavailable.
│                             # Both proxy HTTP over BLE to load the full Web UI.
│                             #   linux/   — Go + GTK4/libadwaita desktop app (opens browser via local proxy)
│                             #   android/ — Kotlin Android app (embedded WebView via local proxy)
└── ci-source/                # Custom CI runner source (./ci auto-builds from here)
```

---

## Build & Run

### Backend
```bash
cd server/backend
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
cd server/frontend
npm install
npm run dev                                   # Dev server on port 3000 (not default 5173)
npm run build                                 # Production build → ../backend/OS/dist/
npm run lint
npm run typecheck                             # TypeScript checking (yes, on .jsx files)
npm test                                      # Vitest (not Jest)
npm run scan:colors                           # Detect hardcoded colors in UI code
```

### E2E Tests
```bash
cd e2e-tests
npm install
npx playwright install chromium
npm test                                      # E2E_BASE_URL defaults to http://localhost:8080
```

### LibreServ Connect (cloud SaaS module)
```bash
cd connect
cp configs/connect.yaml.example configs/connect.yaml   # Required first time
make build                                    # → bin/connect-server
make run                                      # Build + run
make test                                     # Unit tests
make lint                                     # gofmt + go vet
```
Env prefix: `CONNECT_` (viper), e.g. `CONNECT_SERVER_PORT`, `CONNECT_AUTH_ADMIN_TOKEN_SECRET`.

### BLE Companion Apps
Linux desktop app (Go + GTK4/libadwaita):
```bash
cd companion/linux
go mod tidy
go build -o libreserv-ble-companion           # Requires BlueZ, GTK4, libadwaita
./libreserv-ble-companion
```

Android app (Kotlin + Gradle):
```bash
cd companion/android
./gradlew assembleDebug                     # Requires Android SDK 34
# APK → app/build/outputs/apk/debug/app-debug.apk
```

### Backend with BLE support
The backend BLE GATT peripheral is compiled only with the `libreserv_ble` build tag.
```bash
cd server/backend
make ble-build                                # Build with BLE support
make ble-run                                  # Build + run with BLE
```
When BLE is enabled, a companion app can connect over Bluetooth LE and proxy HTTP requests to access the Web UI without Wi-Fi.

---

## Conventions

### PLAIN LANGUAGE (non-negotiable)

LibreServ's users are **not technical**. The product goal is "99% of users shouldn't need a terminal." Every piece of user-facing text — error messages, UI labels, help text, setup wizards — must be written for someone who doesn't know what any of these acronyms mean:

- **Never** expose raw technical terms in user-facing text without a plain-language gloss
- **Never** assume the user knows where to find a credential, what a protocol does, or what an error code means
- **Always** explain what to **do**, not just what went wrong. A bad error: `"SMTP connection refused"`. A good error: `"Could not connect to your email provider. Check that the server address and port are correct in Settings → Email."`
- **Always** explain where a value comes from before asking for it. A bare input field labeled "API Token" is a failure. Say: `"Your API token is on cloudflare.com → Profile → API Tokens → Create Token."`
- **Always** explain why something is needed, not just what it is. A user doesn't care what DNS is — they care that `"We need this so your apps can be reached at addresses like nextcloud.yourdomain.com instead of a numbered IP address."` Every settings field, every wizard step, every permission prompt must answer "why do you need this?" before asking for it.
- Technical terms that need plain-language treatment at point of use: SMTP, SSH, DNS, ACME, TLS/HTTPS, CSRF, JWT, port, subdomain, Caddy, Podman, API, webhook, OIDC, DNS-01, DDNS

This applies to frontend UI, API error messages shown to users, and any documentation a user might see. It does **not** apply to code comments, log entries, or internal developer docs.

### Go
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

### Frontend
- File extensions: `.jsx` (not `.tsx`) — but `npm run typecheck` still validates via JSDoc/TS-check
- Test runner: **Vitest** (not Jest), uses `@testing-library/react` + jsdom
- Vite dev port: **3000** (hardcoded, `strictPort: true`); proxies `/api` and `/health` to `localhost:8080`
- Import order: React → Third-party → Local (include `.jsx` extension in imports)
- Run `npm run scan:colors` when modifying UI to detect hardcoded colors

### Design / Theme
- **Read branding repo** before UI work: https://gt.plainskill.net/LibreLoom/libreloom-branding
- Theme uses CSS custom properties that swap on `.dark` class:
  - `--primary` = page background (white/light, black/dark)
  - `--secondary` = text color (black/light, white/dark)
  - `--accent` = subtle highlights (#767676 both modes)
- Tailwind maps: `bg-primary`, `text-secondary`, `bg-accent`, etc.
- **CRITICAL contrast rule**: Cards on `bg-primary` use `bg-secondary text-primary`. On `bg-secondary` surfaces, use `text-primary`. On `bg-primary` surfaces, use `text-secondary`.
- Border radius: pill `9999px`, card/large `24px`
- No `.gz` pre-compression needed — Vite build already generates `.gz` alongside files; backend serves them when client sends `Accept-Encoding: gzip`

### Git
- Hosting: Gitea at https://gt.plainskill.net (not GitHub)
- Conventional commits: `feat(scope): description`, `fix(scope): description`
- Branch naming: `task/T{id}-{desc}`, `fix/{desc}`, `feat/{desc}`

---

## Testing

### Backend
```bash
cd server/backend
go test ./...                                          # All unit tests
go test -v -run TestName ./internal/apps               # Specific test
go test -race ./internal/auth                           # Race detector
go test -coverprofile=coverage.out ./cmd/... ./internal/...  # Coverage
```

### Frontend
```bash
cd server/frontend
npm test                                               # All tests
npm test -- src/hooks/useAuth.test.jsx                 # Single file
npm test -- --coverage                                 # With coverage
npm test -- --watch                                    # Watch mode
```

### Integration (requires Podman)
```bash
cd server/backend
go test -v -tags=integration ./tests/integration/...
```

---

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
rm -rf server/backend/dev/data server/backend/dev/apps server/backend/dev/logs
```

---

## Key Notes

- **Database:** SQLite. Multiple migration files in `internal/database/migrations/`
- **Container Runtime:** Required for app runtime (`podman compose`). Integration tests also need Podman.
- **Config:** `server/backend/configs/libreserv.yaml` — must be created from `.example` before first run
- **Secrets:** If `jwt_secret`/`csrf_secret` are empty at startup, LibreServ generates and persists them to the config file. If config is read-only, set `LIBRESERV_AUTH_JWT_SECRET` / `LIBRESERV_AUTH_CSRF_SECRET` env vars instead.
- **Frontend build output:** `server/backend/OS/dist/` (gitignored). Production binaries with embedded frontend: `BUILD_TAGS=embedfront make build`
- **Restic:** Backup system requires restic binary. `make restic-fetch` downloads it; `embedrestic` build tag bundles it in the binary.
- **Caddy:** Reverse proxy for HTTPS. Mode can be `enabled`/`noop`/`disabled` in config. ACME certs via DNS-01 challenge.
- **CI:** `./ci` is a custom Go binary. Auto-builds from `ci-source/` on first run. No GitHub Actions — all CI is local.
- **No `libreserv.sh`** in repo — use `make run` from `server/backend/` for development instead
- **Connect module:** `gt.plainskill.net/LibreLoom/LibreServConnect` — independent Go module in `connect/`. It has its own chi/v5 router, SQLite database, config (env prefix `CONNECT_`), and admin/device APIs. Not part of the main backend binary.
- **BLE proxy:** `internal/network/bluetooth/` implements a GATT peripheral that proxies HTTP over BLE. Compiled only with the `libreserv_ble` build tag (see `make ble-build`). The `companion/` apps connect to this service.

## Frontend Components

- **Dropdown** — Always use the project's `Dropdown` component (`src/components/common/Dropdown.jsx`) instead of a raw `<select>`. It accepts `options` as `Array<{value: string, label: string}>`, supports `fullWidth`, `bg` ( `"primary"` | `"secondary"`), and `onChange(value: string)`.
- **Model fetch endpoint** — `POST /settings/ai-support/models` (admin-only) accepts `{ base_url, api_key }` and returns `{ models: [] }` fetched live from the provider. Use this to populate model Dropdowns in AI config modals.
- **ChatHeader crash guard** — `ChatHeader`'s `ModelPill` must guard against empty `modelOptions` (e.g. `resolvedModelOptions[0]?.value || ""`), because `chat.models` starts empty before `loadModels` resolves.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **LibreServ** (9375 symbols, 26190 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/LibreServ/context` | Codebase overview, check index freshness |
| `gitnexus://repo/LibreServ/clusters` | All functional areas |
| `gitnexus://repo/LibreServ/processes` | All execution flows |
| `gitnexus://repo/LibreServ/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Notes for Agents

- **Go versions are real.** The Go version declared in this repository (currently 1.26) exists in real life — not just in this project's environment. Do not question whether `golang:1.26-alpine`, `golang:1.26-bookworm`, or any other Go 1.26 image is available: it is. Treat Go toolchain versions mentioned in this repo as unconditionally available.
