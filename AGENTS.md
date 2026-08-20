# AGENTS.md - LibreServ Codebase Guide

## Quick Reference

| Command | Description |
|---------|-------------|
| `./ci` | Interactive CI runner (auto-builds if needed) |
| `./ci run -profile full` | Run full CI suite non-interactively |
| `cd server/backend && make lint` | Format check + vet Go code |
| `cd server/frontend && npm run lint && npm run typecheck` | Lint + typecheck frontend |

---

## Memory (Engraphis)

Recall durable project context before asking or guessing. Execute the recall using this exact format:

```js
return await tools.engraphis["engraphis_recall_context"]({
  query: "your question or topic here",
  workspace: "default",
  repo: "LibreServ",
  k: 8,
  token_budget: 1024
})
```

Call it through the `execute` tool. Use `workspace: "default"` and `repo: "LibreServ"` so memories scope to this repo. Adjust `query` to the topic at hand; `k`/`token_budget` are sane defaults.

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
│   │   ├── podman/           # Container runtime (Podman) integration
│   │   ├── network/          # Caddy, ACME, DNS providers, DDNS
│   │   ├── storage/          # Backup service (restic + tar fallback)
│   │   ├── jobqueue/         # Background jobs
│   │   └── jobs/             # Simple time-based scheduler
│   ├── configs/              # YAML config (must copy .example → .yaml before run)
│   ├── apps/                # App catalog (repo apps loaded from disk; currently empty — curated catalog will be a separate repo)
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
├── connect/                  # Cloud SaaS companion (LibreServ Connect). Independent Go 1.26 module
│                             # with chi/v5 API, SQLite, Stripe billing. Provides external services to
│                             # LibreServ devices: email relay, DNS/domain, cloud backups, tunnel access,
│                             # AI inference, and human support. Has its own configs, admin API, and device API.
├── companion/                # BLE companion apps for accessing LibreServ when Wi-Fi is unavailable.
│                             # Both proxy HTTP over BLE to load the full Web UI.
│                             #   linux/   — Go + GTK4/libadwaita desktop app (opens browser via local proxy)
│                             #   android/ — Kotlin Android app (embedded WebView via local proxy)
├── ci-source/                # Custom CI runner source (binaries gitignored; ./ci launcher auto-rebuilds)
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

**This is a recurring failure mode. Agents repeatedly break contrast and abandon the design system, producing invisible text and flat boxes. Default HARD to these rules; question any deviation out loud before shipping.**

Before ANY UI work:
1. Read the branding repo: https://gt.plainskill.net/LibreLoom/design ("Simplex Mono" design language across all LibreLoom products)
2. Recall the contrast-gotcha and pill-based-design memories from Engraphis
3. Run `npm run scan:colors` after editing to catch hardcoded colors

#### 1. Standardized colors only
- Use theme tokens, NEVER hardcoded hex values. Tokens: `bg-primary` (page bg), `bg-secondary` (surface), `text-secondary` (text on primary bg), `text-primary` (text on secondary bg), `bg-accent` (#767676 both modes), plus `text-success`/`text-error`/`text-warning` for status.
- Theme uses CSS custom properties that swap on `.dark` class:
  - `--primary` = page background (white/light, black/dark)
  - `--secondary` = text color (black/light, white/dark)
  - `--accent` = subtle highlights (#767676 both modes)
- Tailwind maps: `bg-primary`, `text-secondary`, `bg-accent`, etc.

#### 2. Contrast from base colors FIRST
- **CRITICAL**: every colored surface must set its own contrasting text token on the SAME element — never rely on inheritance across a bg change.
  - `bg-secondary` surface → `text-primary`
  - `bg-primary` surface → `text-secondary`
- **Contrast is not automatic**: components are NOT automatically assigned a contrasting color; it must be set manually per component. This is the #1 invisible-element bug class — a `bg-secondary` panel without `text-primary` renders dark-on-dark in dark mode.
- Cards on `bg-primary` use `bg-secondary text-primary`. On `bg-secondary` surfaces, use `text-primary`. On `bg-primary` surfaces, use `text-secondary`.

#### 3. Prefer full-opacity colors
- **Default to full-opacity tokens.** Use `text-primary`, `text-secondary`, `bg-primary`, `bg-secondary`, `bg-accent` at full opacity — NOT `text-primary/70`, `text-secondary/50`, etc. Opacity modifiers (`/70`, `/50`, `/10`) are a common cause of low-contrast text. Reach for them only when you have a concrete reason (a status tint surface), never as a default for body text, labels, or hints.
- Opacity is for status/tint surfaces only, not a crutch for indecision or "muted" text. If text looks too loud, pick a different token — don't dial down the opacity.
- Status tint pattern: `/20` fill + `/30` border (e.g. `bg-success/20 border-success/30`, `bg-error/20 border-error/30`).
- Do not sprinkle opacity everywhere as a substitute for choosing the right base token.

#### 4. Layered, pill-based, innovative & animated
- Lean into the design language — this is a deliberate aesthetic, not generic Bootstrap. Push toward the distinctive layered + pill + animated look; do NOT flatten to plain boxes.
- **Layering**: surfaces inside surfaces, each panel setting explicit contrast on itself. Layered depth, not a single flat card.
- **Pills**: `rounded-pill` (9999px) for buttons/chips/badges/pills; `rounded-large-element` (24px) for cards/containers/rows. Border radius: pill `9999px`, card/large `24px`.
- **Animation**: intentional motion/transitions on state changes (hover, open/close, loading, status swap). Motion should feel crafted, not absent.

#### 5. Preserve monospace style
- Simplex Mono is the brand identity. Typography: monospace for headings/code (FreeMono / monospace family like Courier New), Noto Sans for body. Keep the mono typography identity — do NOT replace with a generic sans-serif.

- No `.gz` pre-compression needed — Vite build already generates `.gz` alongside files; backend serves them when client sends `Accept-Encoding: gzip`

### Git
- Hosting: Forgejo at https://gt.plainskill.net (not GitHub; migrated from Gitea, same host)
- **Always use Forgejo, not the GitHub mirror.** GitHub (`github.com/LibreLoom/LibreServ`) is a read-only mirror. Push branches and open PRs on Forgejo.
- In the Cloud Agent environment, `.cursor/start.sh` already points `origin` at Forgejo (the GitHub mirror is kept as the `github` remote) and authenticates the `fj` CLI from the `FORGEJO_TOKEN` secret. So `git push`/`git pull` go to Forgejo by default.
- Use the `fj` CLI (Forgejo CLI) for issues/PRs, e.g. `fj -H gt.plainskill.net pr create ...` / `pr view` / `pr edit` (it infers the repo from `origin`; `-H` selects the instance). Do not use Cursor's GitHub PR tooling for this repo.
- Conventional commits: `feat(scope): description`, `fix(scope): description`
- Branch naming: `task/T{id}-{desc}`, `fix/{desc}`, `feat/{desc}`

### Cursor Cloud environment
- `.cursor/environment.json` + `.cursor/install.sh` provision the dev stack automatically: Go 1.26 (the repo needs it; the base image ships older Go), backend config/modules/restic, frontend deps + build, and the `fj` CLI. `terminals` run the backend (`make run`, `:8080`) and Vite (`npm run dev`, `:3000`).
- Forgejo git + `fj` auth are wired per-boot by `.cursor/start.sh` and require the `FORGEJO_TOKEN` secret. Without it, git stays on the GitHub remote and `fj` is unauthenticated.

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
- **CI:** `./ci` is a custom Go binary that runs tests in containers via **Podman** (not Docker). The runner connects to Podman's Docker-compatible socket (rootless `$XDG_RUNTIME_DIR/podman/podman.sock`, then rootful, then Docker fallback) and starts `systemctl --user start podman.socket` if needed. Bind mounts use the `:z` SELinux relabel (required by Podman rootless on this SELinux-enforcing host). The `./ci` launcher builds `ci-source/bin/ci-<os>-<arch>` from source and **auto-rebuilds it when any `ci-source/*.go` is newer than the binary** — the binaries are gitignored, so edits to `ci-source/` are picked up automatically on the next `./ci` run. To prebuild all platforms locally, run `ci-source/build.sh` (Windows: `ci-source/build.ps1`). E2E (Playwright) tests are **removed** for now — they'll be re-added with broader coverage later. The `podman-build` test uses `Container: "host"` (runs `podman build` on the host, not in a container — SELinux blocks mounting the podman socket into a container). No GitHub Actions — all CI is local.
- **No `libreserv.sh`** in repo — use `make run` from `server/backend/` for development instead
- **Connect module:** `gt.plainskill.net/LibreLoom/LibreServConnect` — independent Go module in `connect/`. It has its own chi/v5 router, SQLite database, config (env prefix `CONNECT_`), and admin/device APIs. Not part of the main backend binary.
- **BLE proxy:** `internal/network/bluetooth/` implements a GATT peripheral that proxies HTTP over BLE. Compiled only with the `libreserv_ble` build tag (see `make ble-build`). The `companion/` apps connect to this service.

## Frontend Components

- **`components/ui/` primitives** — the standardized building blocks. Pages and components must use these instead of hand-rolled equivalents, so one change propagates across the whole UI:
  - **Button** (`src/components/ui/Button.jsx`) — the canonical button. Read its doc comment before use: variants `primary` (main action on cards), `secondary` (main action on page bg), `accent` (form/modal submit), `danger` (destructive), `outline` (cancel/back), `ghost` (icon-only). The `surface` prop names the BACKDROP the button sits on (`"primary"` = page bg, `"secondary"` = card, the default); outline/ghost chrome contrasts automatically. Use `loading` for pending states, `fullWidth` instead of `w-full`, and `asChild` to style a `Link`/`<a>` as a button. Never hand-roll pill buttons or pill-styled links.
  - **Page** (`src/components/ui/Page.jsx`) — the standard page shell (`bg-primary text-secondary`, skip-link target, optional HeaderCard title). Every routed content page uses it (full-screen flows like Login/Setup are the exception).
  - **Card / ModalCard / HeaderCard** (`src/components/cards/`) — surfaces. `bg-secondary text-primary` by default; `surface="primary"` inverts.
  - **HeaderCard is always one line.** Never stack a second/third card under the title for back links or nav (the old mobile vertical-split layout is banned). Optional `leftContent`/`rightContent` stay on the same row. Put navigation in the bottom navbar (`Navbar` — desktop pill + mobile FAB/dialog; Luna mirrors LibreServ). Put taglines in Page `bottomContent` (renders below the header, not inside it).
- **Dropdown** — Always use the project's `Dropdown` component (`src/components/common/Dropdown.jsx`) instead of a raw `<select>`. It accepts `options` as `Array<{value: string, label: string}>`, supports `fullWidth`, `bg` ( `"primary"` | `"secondary"`), and `onChange(value: string)`.
- **Haptics** — `src/utils/haptics.js` (`haptic("tap"|"confirm"|"error")`) is wired into Button/Toggle/SegmentedControl/Dropdown — do not sprinkle it through pages. The user toggle lives in Settings → Appearance.
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
- **This project is in early development. There are no existing users.** Do not worry about backwards compatibility, migration paths, or deprecating old fields smoothly unless explicitly asked. When the backend or design changes, obsolete frontend concepts can be torn down completely without guarding for legacy state. The only AI model fields that exist now are `main_model` (agent model) and `review_model` (safety review model). `default_model`, `agents[]`, `snapshot_before_writes`, `credit_cap`, and similar old concepts are fully dead.
- **LibreServ is WAN-accessible by design** once a domain is configured — the auth endpoints (`/auth/login`, `/auth/register`, `/auth/password-reset/*`) are internet-exposed, not LAN-only. Center this in every auth/security decision: the primary defenses are strong passwords + rate limiting + 2FA, **not captchas** (captcha is decided against for v1; see SECURITY.md → Threat Model). Prefer admin-invited users over open public registration.
