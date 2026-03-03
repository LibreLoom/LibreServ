# AGENTS.md - LibreServ Codebase Guide

## Quick Reference

| Command | Description |
|---------|-------------|
| `./ci` | Run full CI suite (`./ci.exe` on Windows) |
| `cd server/backend && make test` | Run all backend tests |
| `go test -v -run TestName ./package` | Run single backend test |
| `npm test -- path/to/file.test.jsx` | Run single frontend test |
| `make lint` | Format + lint Go code |
| `npm run lint` | Lint frontend code |

---

## Project Structure

```
LibreServ/
├── server/backend/          # Go 1.23+ backend
│   ├── cmd/                 # Entry point (cmd/libreserv/main.go)
│   ├── internal/            # Core modules
│   │   ├── api/             # HTTP layer (handlers, middleware)
│   │   ├── apps/            # App lifecycle management
│   │   ├── auth/            # Authentication (JWT, sessions)
│   │   ├── database/        # SQLite layer + migrations
│   │   ├── docker/          # Docker integration
│   │   ├── jobqueue/        # Background jobs
│   │   └── validation/      # Input validation
│   ├── configs/             # YAML configuration
│   ├── .env                 # Environment variables
│   └── Makefile
│
└── server/frontend/         # React 19 + Vite
    ├── src/
    │   ├── components/      # UI components
    │   │   ├── app/         # App-specific components
    │   │   ├── backups/     # Backup-related components
    │   │   ├── common/      # Reusable UI (cards, forms, Navbar)
    │   │   └── settings/    # Settings components
    │   ├── pages/           # Route pages (Dashboard, Login, etc.)
    │   ├── hooks/           # Custom hooks (useAuth, useApps)
    │   ├── context/         # React contexts (AuthContext)
    │   ├── layout/          # Layout components
    │   └── utils/           # Utility functions
    ├── index.css            # Tailwind + custom theme
    └── package.json
```

---

## Build Commands

### Backend (Go)
```bash
cd server/backend
make build              # Build binary to bin/libreserv
make run                # Build and run with config
make test               # Run all tests
make test-race          # Race detector on key packages
make test-coverage      # Coverage report (coverage.html)
make vet                # go vet
make fmt-check          # Check formatting
make lint               # fmt-check + vet
make security           # govulncheck + gosec + staticcheck
make clean              # Remove build artifacts
```

### Frontend (React/Vite)
```bash
cd server/frontend
npm install             # Install dependencies
npm run dev             # Dev server (Vite)
npm run build           # Production build
npm run lint            # ESLint
npm run preview         # Preview production build
```

### Single Test Execution
```bash
# Backend - specific test function
go test -v -run TestAppLifecycle ./internal/apps/...
go test -v -run TestAuth ./internal/auth/...

# Backend - all tests in file
go test -v ./internal/api/handlers/auth_test.go

# Frontend - specific test file
npm test -- src/hooks/useAuth.test.jsx
```

---

## Go Style Guide

**Formatting:**
- Always run `go fmt` before commit
- `go vet` must pass
- No unused imports or variables

**Naming Conventions:**
- Packages: lowercase (`validation`, `auth`, `jobqueue`)
- Types: PascalCase (`ValidationError`, `AuthHandler`, `AppManifest`)
- Functions: PascalCase if exported, camelCase if private
- Constants: UPPER_CASE (`ACCESS_COOKIE_NAME`, `MAX_RETRY_ATTEMPTS`)
- Interfaces: `-er` suffix (`Reader`, `Writer`, `Handler`)

**Error Handling:**
- Handle errors explicitly, never ignore with `_`
- Return errors up the stack with context added
- Use `errors.Is()` and `errors.As()` for type checks
- Define sentinel errors for known conditions
- Use `JSONError(w, statusCode, message)` for HTTP responses

**Comments:**
- Package comment: `// Package name provides...`
- Document all exported types and functions
- Complete sentences starting with function name: `ValidateUsername checks...`

**Imports:**
- Standard library first, then external packages
- Group in parentheses when multiple
- Use module path: `gt.plainskill.net/LibreLoom/LibreServ/internal/...`

---

## Design Language

> **⚠️ CRITICAL: Before working on ANY frontend code, you MUST:**
> 1. Read this entire Design Language section
> 2. Review the [LibreLoom Design & Branding Repository](https://gt.plainskill.net/LibreLoom/libreloom-branding) for official design guidelines & requirements, logos, color palettes, and design assets
> 3. Understand when the branding repo is needed:
>    - ✅ **Read branding repo when:** Creating new pages, modifying existing UI components, adding new color schemes, working with logos/branding assets, or unsure about design consistency
>    - ❌ **Not needed for:** Backend-only changes, API modifications, database migrations, configuration changes, or fixing typos
>
> **Failure to follow branding guidelines will result in inconsistent UI and rejected PRs.**

**CSS Framework:** Tailwind CSS with custom theme (`src/index.css`)

**Fonts:**
- Sans: `Noto Sans` (primary)
- Mono: `FreeMono` (code blocks)

**Colors (CSS Variables - theme-aware):**
- Primary: Main brand color (light/dark variants)
- Secondary: Supporting brand color
- Accent: Highlight color
- Status colors: success (green), warning (yellow), error (red), info (blue)

**Border Radius:**
- Pill: `9999px`
- Large: `24px`
- Card: `12px`

**Components:** Reusable UI in `src/components/common/`:
- Cards (`Card`, `StatCard`)
- Forms (form controls, inputs)
- Navigation (`Navbar`, `Sidebar`)
- Interactive (`Dropdown`, `Modal`, `Button`)

**React Patterns:**
- Functional components with hooks
- Export: `export function ComponentName()`
- Use `lazy()` + `Suspense` for route pages
- Wrap with `ErrorBoundary` for error handling
- Use `prop-types` for type checking

**Naming:**
- Components: PascalCase (`DashboardPage`, `AppCard`)
- Functions/variables: camelCase (`handleClick`, `isLoading`)
- Hooks: prefix with `use` (`useAuth`, `useApps`, `useSettings`)
- Files: Match component name (`DashboardPage.jsx`)

**Imports Order:** React → Third-party → Local (with `.jsx` extension)

---

## File Organization

**Backend** (paths relative to `server/backend/`):
- Handlers: `internal/api/handlers/{resource}.go`
- Middleware: `internal/api/middleware/`
- Tests: `{file}_test.go` alongside source

**Frontend** (paths relative to `server/frontend/`):
- Pages: `src/pages/{PageName}.jsx`
- Components: `src/components/{category}/{Component}.jsx`
- Hooks: `src/hooks/{hookName}.jsx`
- Context: `src/context/{ContextName}.jsx`

---

## Testing

### Backend
```bash
go test -v ./...                    # All tests
go test -v ./internal/apps          # Specific package
go test -v -run TestAppLifecycle    # Specific test
go test -race ./internal/auth       # Race detector
go test -cover ./...                # Coverage
```

### Frontend
```bash
npm test                            # Run tests
npm test -- --coverage              # With coverage
```

---

## Error Patterns

### Go
```go
// API error response
JSONError(w, http.StatusBadRequest, "Invalid input")

// Auth check
userID, ok := middleware.GetUserID(r.Context())
if !ok {
    JSONError(w, http.StatusUnauthorized, "Authentication required")
    return
}

// Validation
validator := validation.New().
    ValidateUsername(req.Username).
    ValidateNotEmpty("password", req.Password, "Password")
if validator.HasErrors() {
    JSONError(w, http.StatusBadRequest, validator.FirstError().Message)
    return
}
```

### JavaScript/React
```jsx
// Auth pattern with ErrorBoundary
import { useAuth } from "./hooks/useAuth";

function RequireAuth({ children }) {
    const { me, initialized } = useAuth();
    if (!initialized) return <LoadingFast />;
    return me ? children : <Login />;
}
```

---

## Git Conventions

**Branch Naming:**
- `task/T{id}-{description}` - ROADMAP tasks
- `fix/{description}` - Bug fixes
- `feat/{description}` - New features

**Commit Messages:**
```
type(scope): description

[optional body]

[footer: Closes #123]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

---

## Key Notes

- **Go Module:** `gt.plainskill.net/LibreLoom/LibreServ`
- **Database:** SQLite with migrations in `internal/database/migrations/`
- **Environment:** `.env` file in `server/backend/` for local config
- **Docker:** Required for app runtime (Docker Compose v2)
- **Reverse Proxy:** Caddy for HTTPS/SSL
- **Security:** JWT tokens, CSRF protection, rate limiting
- **Config:** `server/backend/configs/libreserv.yaml`

---

## Common Tasks

**New API endpoint:**
1. Create handler in `internal/api/handlers/{resource}.go`
2. Add route in server setup
3. Write test in `{resource}_test.go`

**New frontend page:**
1. Create `src/pages/{PageName}.jsx`
2. Add route in `App.jsx`
3. Test with `npm run dev`

**Run application:**
```bash
cd server/frontend && npm install
cd ../backend
./libreserv.sh setup
./libreserv.sh run
```

---

## Resources

- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution workflow
- [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) - Developer guide
- [ROADMAP.md](ROADMAP.md) - Task list and project status
- [README.md](README.md) - Quick start guide
