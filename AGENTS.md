# AGENTS.md - LibreServ Codebase Guide

## Quick Reference

| Command | Description |
|---------|-------------|
| `./ci` | Run full CI suite |
| `make lint` | Format + lint Go code |
| `npm run lint && npm run typecheck` | Lint + typecheck frontend |

---

## Project Structure

```
LibreServ/
├── server/backend/          # Go 1.25 backend (chi/v5 router)
│   ├── cmd/libreserv/      # Entry point
│   ├── internal/
│   │   ├── api/            # HTTP handlers + middleware
│   │   ├── apps/           # App lifecycle management
│   │   ├── auth/           # JWT authentication
│   │   ├── database/       # SQLite + migrations
│   │   ├── docker/         # Docker integration
│   │   ├── jobqueue/       # Background jobs
│   │   └── validation/     # Input validation
│   ├── configs/            # YAML configuration
│   ├── OS/dist/            # Embedded frontend (gitignored)
│   └── Makefile
│
└── server/frontend/       # React 19 + Vite + Tailwind 4
    └── src/
        ├── components/     # UI components
        ├── pages/          # Route pages (.jsx)
        ├── hooks/          # Custom hooks
        ├── context/        # React contexts
        └── layout/         # Layout components
```

---

## Build Commands

### Backend
```bash
cd server/backend
make build              # Build binary to bin/libreserv
make run                # Build and run (LIBRESERV_INSECURE_DEV=true)
make test               # Run all tests
make lint               # fmt-check + vet
make security           # govulncheck + gosec + staticcheck
make frontend-build     # Build frontend to OS/dist/
BUILD_TAGS=embedfront make build  # Binary with embedded frontend
```

### Frontend
```bash
cd server/frontend
npm install             # Install dependencies
npm run dev              # Dev server (Vite)
npm run build            # Production build
npm run lint             # ESLint
npm run typecheck        # TypeScript checking
npm test                 # Vitest tests
```

---

## Important Conventions

### Go
- HTTP router: `github.com/go-chi/chi/v5` (not gin)
- Error response: `JSONError(w, statusCode, message)`
- Auth context: `middleware.GetUserID(r.Context())`
- Module path: `gt.plainskill.net/LibreLoom/LibreServ`
- Always run `go fmt` before commit; `go vet` must pass

### Frontend
- Test runner: **Vitest** (not Jest)
- CSS: Tailwind 4 with custom theme in `index.css`
- File extensions: `.jsx` (not `.tsx`)
- Run `npm run scan:colors` when modifying UI to detect hardcoded colors
- Import order: React → Third-party → Local (with `.jsx` extension)

### Design
- **Read branding repo** before working on UI: https://gt.plainskill.net/LibreLoom/libreloom-branding
- Colors via CSS variables (theme-aware)
- Border radius: pill `9999px`, large `24px`, card `12px`
- **CRITICAL: Color contrast** - Cards use `bg-secondary text-primary`. Always check parent container's background before choosing colors. Use `text-primary` on card backgrounds, `text-secondary` on `bg-primary` elements

---

## Testing

### Backend
```bash
go test -v ./...                         # All tests
go test -v -run TestName ./package       # Specific test
go test -race ./internal/auth            # Race detector
```

### Frontend
```bash
npm test -- src/hooks/useAuth.test.jsx    # Single test file
npm test -- --coverage                    # With coverage
npm test -- --watch                      # Watch mode
```

---

## Common Tasks

**New API endpoint:**
1. Create handler in `internal/api/handlers/{resource}.go`
2. Add route in `internal/api/server.go`
3. Write test in `{resource}_test.go`

**New frontend page:**
1. Create `src/pages/{PageName}.jsx`
2. Add route in `src/App.jsx`

**Run application:**
```bash
cd server/frontend && npm install
cd ../backend
./libreserv.sh setup
./libreserv.sh run
```

---

## Key Notes

- **Hosting:** Gitea at https://gt.plainskill.net (not GitHub)
- **Database:** SQLite with migrations in `internal/database/migrations/`
- **Docker:** Required for app runtime (`docker compose` v2)
- **Config:** `server/backend/configs/libreserv.yaml`
- **Frontend build output:** `server/backend/OS/dist/` (gitignored)
- **Reset dev data:** `rm -rf server/backend/dev/data server/backend/dev/apps server/backend/dev/logs`

---

## Resources

- [ROADMAP.md](ROADMAP.md) - Task list and project status
- [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) - Detailed development guide
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution workflow
