# LibreServ Developer Guide

This guide covers building, testing, debugging, and extending the LibreServ backend. It is intended for developers who want to contribute to the project or build LibreServ from source.

## Table of Contents

- [Project Overview](#project-overview)
- [Project Structure](#project-structure)
- [Development Environment Setup](#development-environment-setup)
- [Building from Source](#building-from-source)
- [Database Development](#database-development)
- [Testing](#testing)
- [Debugging](#debugging)
- [Architecture Overview](#architecture-overview)
- [API Development](#api-development)
- [Frontend Development](#frontend-development)
- [Podman Development](#podman-development)
- [Code Style and Conventions](#code-style-and-conventions)
- [Contributing Guidelines](#contributing-guidelines)

---

## Project Overview

LibreServ is a self-hosted application platform that enables users to install, manage, and operate applications in an isolated environment. The system consists of:

- **Backend**: Go-based HTTP API handling app lifecycle, configuration, and system operations
- **Frontend**: React-based web UI for administration and management
- **Runtime**: Podman Compose-based application orchestration with automatic reverse proxy (Caddy)

The platform provides:
- Application catalog and installation
- Container lifecycle management (start, stop, update, remove)
- Automated backups and restores
- Health monitoring and auto-repair
- Reverse proxy configuration with automatic HTTPS
- Audit logging and history tracking

---

## Project Structure

```
LibreServ/
├── server/
│   ├── backend/                    # Go backend application
│   │   ├── cmd/
│   │   │   ├── libreserv/         # Application entry point
│   │   │   │   └── main.go        # Main function and initialization
│   │   ├── internal/
│   │   │   ├── agent/             # AI agent persistence
│   │   │   ├── api/               # HTTP server and handlers
│   │   │   │   ├── server.go      # Server configuration and startup
│   │   │   │   ├── router.go      # Route setup
│   │   │   │   ├── handlers/      # Request handlers by resource
│   │   │   │   │   ├── apps.go    # App management endpoints
│   │   │   │   │   ├── auth.go    # Authentication endpoints
│   │   │   │   │   ├── backups.go # Backup endpoints
│   │   │   │   │   ├── catalog.go # Catalog endpoints
│   │   │   │   │   ├── network.go # Network configuration endpoints
│   │   │   │   │   ├── setup.go   # Setup wizard endpoints
│   │   │   │   │   ├── system.go  # System operation endpoints
│   │   │   │   │   ├── audit.go   # Audit log endpoints
│   │   │   │   │   └── ...        # Additional handler files
│   │   │   │   └── middleware/    # HTTP middleware (auth, logging, rate limit, etc.)
│   │   │   ├── apps/              # App catalog and lifecycle management
│   │   │   │   ├── catalog.go     # Built-in and custom app catalog
│   │   │   │   ├── installer.go   # Template processing and installation
│   │   │   │   ├── manager.go     # App lifecycle orchestration
│   │   │   │   ├── types.go       # All type definitions
│   │   │   │   ├── port_manager.go# Host port allocation
│   │   │   │   ├── script_executor.go # Script execution
│   │   │   │   ├── manifest.go    # App manifest handling
│   │   │   │   ├── repo.go        # Repository app sources
│   │   │   │   └── metrics_cache.go # App metrics caching
│   │   │   ├── audit/             # Audit logging system (service.go, service_test.go)
│   │   │   ├── auth/              # JWT authentication, password reset
│   │   │   ├── config/            # Config loading (viper + YAML)
│   │   │   ├── constants/         # Shared constants
│   │   │   ├── database/          # SQLite database layer
│   │   │   │   ├── db.go          # Database connection and setup
│   │   │   │   ├── migrations/    # Database schema migrations
│   │   │   │   └── migrations.go  # Migration runner
│   │   │   ├── podman/            # Podman client abstraction
│   │   │   ├── email/             # Email sending (templates, markdown)
│   │   │   ├── errors/            # Error types
│   │   │   ├── jobqueue/          # Persistent job queue with retry logic
│   │   │   ├── jobs/              # Simple time-based scheduler
│   │   │   ├── license/           # License validation
│   │   │   ├── logger/            # Structured logging setup
│   │   │   ├── monitoring/        # Health checking and metrics
│   │   │   ├── network/           # Caddy, DNS, ACME certificate management
│   │   │   │   ├── caddy.go       # Caddy Admin API client
│   │   │   │   ├── dns.go         # DNS provider interface
│   │   │   │   ├── acme.go        # ACME certificate management
│   │   │   │   ├── ddns.go        # DDNS auto-update
│   │   │   │   └── probe.go       # Network probing
│   │   │   ├── notify/            # Notification services
│   │   │   ├── runtime/           # Container runtime abstraction
│   │   │   ├── security/          # Security validation and monitoring
│   │   │   ├── settings/          # DB-backed settings management
│   │   │   ├── setup/             # First-run setup orchestration
│   │   │   ├── storage/           # Backup service (restic + tar fallback)
│   │   │   ├── subscription/      # Subscription and credit usage tracking
│   │   │   ├── support/           # Remote support sessions
│   │   │   ├── system/            # Platform self-update logic
│   │   │   ├── util/              # Utility functions
│   │   │   └── validation/        # Input validation
│   │   ├── apps/                  # App template directories
│   │   │   └── builtin/           # Built-in app definitions
│   │   ├── configs/               # Configuration files
│   │   └── go.mod                 # Go module definition
│   └── frontend/                  # React frontend application
│       ├── src/
│       │   ├── components/        # React components
│       │   │   ├── app/           # App-related components
│       │   │   ├── backups/       # Backup components
│       │   │   ├── cards/         # Card components
│       │   │   ├── common/        # Common/shared components
│       │   │   ├── onboarding/    # Onboarding components
│       │   │   ├── settings/      # Settings components
│       │   │   ├── setup/         # Setup wizard components
│       │   │   ├── smtp/          # SMTP components
│       │   │   └── ui/            # UI primitives
│       │   ├── pages/             # Page components (.jsx)
│       │   ├── hooks/             # Custom React hooks
│       │   ├── context/           # React contexts
│       │   ├── layout/            # Layout components
│       │   └── utils/             # Utility functions
│       ├── package.json           # NPM dependencies
│       └── vite.config.js         # Vite configuration
├── docs/                          # Documentation
│   ├── APP_PACKAGE_FORMAT.md      # Custom app package specification
│   ├── DEVELOPER_GUIDE.md         # This guide
│   ├── OPERATOR_GUIDE.md          # Operations documentation
│   └── SCRIPT_DEVELOPMENT_GUIDE.md# Script development reference
├── Dockerfile                     # Production image build
├── Makefile                       # Build automation
└── README.md                      # Project overview
```

---

## Development Environment Setup

### Prerequisites

Ensure the following tools are installed on your development system:

| Tool | Version | Purpose |
|------|---------|---------|
| Go | 1.26+ | Backend development and building |
| Node.js | 20+ | Frontend development |
| Podman | Latest | Container runtime for testing |
| podman-compose | Latest | Compose command (`podman compose`) |
| Git | Latest | Version control |
| Make | Latest | Build automation |

### Verifying Prerequisites

```bash
# Check Go version
go version

# Check Node.js version
node --version

# Check Podman availability
podman --version
podman compose version

# Verify Podman is running
podman info
```

### Initial Checkout and Dependencies

```bash
# Clone the repository
git clone https://gt.plainskill.net/LibreLoom/LibreServ.git
cd LibreServ

# Install backend dependencies
cd server/backend
go mod download

# Install frontend dependencies
cd ../frontend
npm install
```

### Resetting Development Data

To completely reset the backend development data (database, app data, logs):

```bash
cd server/backend
rm -rf dev/data dev/apps dev/logs
```

This removes:
- `dev/data/` — SQLite database and related data
- `dev/apps/` — Installed app data
- `dev/logs/` — Application logs

After resetting, restart the backend and navigate to `/setup` to go through initial setup again.

---

## Building from Source

### Backend Build Commands

The `Makefile` in `server/backend` provides standardized build commands:

```bash
cd server/backend

# Build the backend binary (development)
make build

# The binary is output to: bin/libreserv

# Build with version information injected
make build VERSION="1.0.0-dev" COMMIT="$(git rev-parse HEAD)"

# Clean build artifacts
make clean
```

### Frontend Build Commands

```bash
cd server/frontend

# Development server with hot reload
npm run dev

# Production build
npm run build

# Preview production build locally
npm run preview

# Lint code
npm run lint

# Type check
npm run typecheck
```

### Full Production Build

To build the complete production image with embedded frontend:

```bash
# From repository root
cd server/backend

# Build with embedded frontend (requires frontend build output)
BUILD_TAGS=embedfront make build

# Or build the container image directly
podman build -t libreserv:dev .
```

### Build Flags and Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VERSION` | Version string embedded in binary | git describe |
| `COMMIT` | Git commit hash | git rev-parse HEAD |
| `DATE` | Build timestamp | current date (optional) |
| `BUILD_TAGS` | Go build tags (e.g., `embedfront`) | none |

---

## Database Development

### Database Overview

LibreServ uses SQLite for data persistence. The database stores:

- User accounts and authentication
- Installed applications and their configurations
- App instances and their state
- Audit logs
- Backup metadata
- Scheduled jobs
- Health check history
- Security events

### Database Migrations

Migrations are stored in `server/backend/internal/database/migrations/` and follow a sequential numbering scheme.

**Creating a New Migration:**

1. Create a new SQL file with the next sequence number:
   ```
   migrations/002_add_feature_table.sql
   ```

2. Write the migration SQL (migrations run in transactions):
   ```sql
   -- Create new table
   CREATE TABLE IF NOT EXISTS new_feature (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   );

   -- Add column to existing table
   ALTER TABLE existing_table ADD COLUMN new_column TEXT DEFAULT '';
   ```

3. Migrations are automatically detected and applied on startup.

4. For Go-based migrations or complex logic, create a migration runner in `internal/database/`:

```go
// internal/database/migrate.go
package database

import "database/sql"

func RunCustomMigration(db *sql.DB) error {
    // Complex migration logic here
    return nil
}
```

**Migration Safety:**

- All migrations run in database transactions
- Pre-migration backups created automatically

### Database Access for Development

```bash
# Start LibreServ to create the database
cd server/backend && ./bin/libreserv

# Access the SQLite database from the dev directory
sqlite3 dev/data/libreserv.db
```

### Testing with Database

```bash
# Run database-related tests
go test -v ./internal/database/...

# Run tests with verbose output
go test -v -count=1 ./internal/database/...
```

---

## Testing

### Running Tests

Execute all tests from the `server/backend` directory:

```bash
cd server/backend

# Run all tests
go test -v ./...

# Run tests with coverage
go test -v -coverprofile=coverage.out ./...
go tool cover -html=coverage.out -o coverage.html

# Run tests matching a pattern
go test -v ./internal/apps/ -run TestUpdateHistory

# Run a specific test
go test -v ./internal/api/ -run TestAppInstall
```

### Test Organization

| Directory | Purpose |
|-----------|---------|
| `*_test.go` files | Unit tests alongside source files |
| `internal/api/` | API endpoint tests |
| `internal/apps/` | App lifecycle tests |
| `internal/database/` | Database operation tests |

### Writing Tests

```go
// Example test structure
func TestAppLifecycle(t *testing.T) {
    // Setup
    db := setupTestDB(t)
    defer db.Close()

    // Create test app
    app := &App{ID: "test-app", Name: "Test App"}
    err := db.SaveApp(app)
    assert.NoError(t, err)

    // Test operations
    err = app.Install()
    assert.NoError(t, err)

    err = app.Start()
    assert.NoError(t, err)

    // Verify state
    state, err := app.GetState()
    assert.Equal(t, StateRunning, state)
}
```

### Frontend Testing

```bash
cd server/frontend

# Run unit tests
npm test

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

---

## Debugging

### Backend Debugging

**Using Delve (Go debugger):**

```bash
# Install Delve
go install github.com/go-delve/delve/cmd/dlv@latest

# Start debug server
cd server/backend
dlv debug ./cmd/libreserv

# In dlv console:
(dlv) break main.main
(dlv) continue
(dlv) locals
(dlv) next
(dlv) print variable_name
```

**Logging:**

The backend uses structured logging. Increase log verbosity:

```bash
# Run with debug logging (via config)
# Set logging.level: debug in libreserv.yaml, or...

# Via environment variable
LIBRESERV_LOGGING_LEVEL=debug ./bin/libreserv
```

**HTTP Request Logging:**

Enable request logging middleware for API debugging.

### Frontend Debugging

**Browser DevTools:**
- Open browser DevTools (F12)
- Check Console for errors
- Use Network tab to inspect API requests
- Use Sources tab to set breakpoints

**React Developer Tools:**
- Install React DevTools browser extension
- Inspect component hierarchy and state
- Profile rendering performance

**VS Code Debugging:**

Create `.vscode/launch.json`:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Launch Chrome",
            "type": "chrome",
            "request": "launch",
            "url": "http://localhost:3000",
            "webRoot": "${workspaceFolder}/server/frontend"
        }
    ]
}
```

### Podman Debugging

```bash
# View container logs
podman compose -f docker-compose.dev.yml logs

# Follow logs in real-time
podman logs -f libreserv-backend

# Execute shell in container
podman exec -it libreserv-backend /bin/sh

# Inspect container state
podman inspect libreserv-backend
```

---

## Architecture Overview

### Request Flow

```
Browser ──HTTP──> Caddy (reverse proxy) ──> LibreServ API (port 8080)
                                              │
                                              ├── SQLite database
                                              ├── Podman (app containers)
                                              ├── Caddy Admin API (port 2019)
                                              └── External services (DNS, ACME)
```

### API Route Structure

```
/api/v1/
├── setup/          # First-run wizard (public)
├── auth/           # Login, register, password reset
├── catalog/        # App catalog browsing
├── apps/           # Installed app management
├── backups/        # Backup/restore
├── email/          # Email testing and domains
├── license/        # License validation
├── network/        # Caddy routes, ACME certs, DNS
├── users/          # User management (admin)
├── settings/       # Application settings
├── system/         # Platform updates
├── monitoring/     # Health and metrics
├── security/       # Security events
├── support/        # Remote support sessions
├── audit/          # Audit log
└── admin/          # Factory reset (admin)
```

### Key Components

- **Catalog**: File-system based registry of app definitions loaded at startup
- **Installer**: Converts app template + user config → Podman Compose deployment
- **Manager**: Handles lifecycle of installed app instances
- **Network Manager**: Caddy config generation, DNS provider abstraction, ACME certificates
- **Job Queue**: Persistent background job system with retry and cancellation
- **Backup Service**: App data backups with local and cloud (B2/S3) targets
- **Monitoring**: Health checks, metrics collection, Prometheus endpoint
- **Security**: Rate limiting, CSRF, JWT auth, security event monitoring

---

## API Development

### Adding a New Endpoint

1. Create or extend a handler file in `internal/api/handlers/`
2. Register the route in `internal/api/router.go`
3. Write tests in a `*_test.go` file next to the handler

### Response Formats

**Success:**
```json
{
    "data": { ... }
}
```

**Error:**
```json
{
    "error": "message"
}
```

Use the `JSONError(w, statusCode, message)` helper for consistent error responses.

---

## Frontend Development

### Project Conventions

- Use `.jsx` extensions (not `.tsx`)
- Functional components with hooks
- Import order: React → Third-party → Local (with `.jsx` extension)
- Tailwind 4 with CSS variables for theme-aware colors
- Run `npm run scan:colors` before committing UI changes

### Available Scripts

```bash
npm run dev              # Development server with HMR
npm run build            # Production build
npm run preview          # Preview production build
npm run lint             # ESLint
npm run typecheck        # TypeScript checking
npm test                 # Vitest tests
npm run scan:colors      # Detect hardcoded colors
```

---

## Podman Development

### Development Mode

When running in development mode, set `LIBRESERV_INSECURE_DEV=true` to bypass production security checks.

### Podman Compose Tips

```bash
# View running containers
podman ps

# View container logs
podman logs -f <container-name>

# Rebuild and restart an app after config changes
podman compose -p libreserv-<instance_id> up -d
```

---

## Code Style and Conventions

### Go
- Run `go fmt` before committing
- Run `go vet ./...` — no warnings
- Follow [Effective Go](https://golang.org/doc/effective_go)
- Use structured logging via `log/slog`

### JavaScript/React
- Run `npm run lint` — no errors
- Use functional components with hooks
- Run `npm run scan:colors` before committing UI changes

---

## Contributing Guidelines

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full contribution workflow.
