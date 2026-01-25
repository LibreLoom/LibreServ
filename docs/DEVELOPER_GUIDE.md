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
- [Docker Development](#docker-development)
- [Code Style and Conventions](#code-style-and-conventions)
- [Contributing Guidelines](#contributing-guidelines)

---

## Project Overview

LibreServ is a self-hosted application platform that enables users to install, manage, and operate applications in an isolated environment. The system consists of:

- **Backend**: Go-based HTTP API handling app lifecycle, configuration, and system operations
- **Frontend**: React-based web UI for administration and management
- **Runtime**: Docker Compose-based application orchestration with automatic reverse proxy (Caddy)

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
│   │   │   └── libreserv/          # Application entry point
│   │   │       ├── main.go         # Main function and initialization
│   │   │       └── main_test.go    # Integration tests
│   │   ├── internal/
│   │   │   ├── api/                # HTTP server and handlers
│   │   │   │   ├── server.go       # Server configuration and startup
│   │   │   │   ├── handlers/       # Request handlers by resource
│   │   │   │   │   ├── apps.go     # App management endpoints
│   │   │   │   │   ├── system.go   # System operation endpoints
│   │   │   │   │   ├── network.go  # Network configuration endpoints
│   │   │   │   │   └── audit.go    # Audit log endpoints
│   │   │   │   └── middleware/     # HTTP middleware (auth, logging, etc.)
│   │   │   ├── apps/               # App catalog and lifecycle management
│   │   │   │   ├── catalog.go      # Built-in and custom app catalog
│   │   │   │   ├── lifecycle.go    # Container lifecycle operations
│   │   │   │   ├── update.go       # Update detection and application
│   │   │   │   └── backup.go       # Backup and restore operations
│   │   │   ├── audit/              # Audit logging system
│   │   │   │   ├── logger.go       # Audit event recording
│   │   │   │   └── query.go        # Audit log queries
│   │   │   ├── database/           # SQLite database layer
│   │   │   │   ├── db.go           # Database connection and setup
│   │   │   │   ├── models/         # Data models and entities
│   │   │   │   └── migrations/     # Database schema migrations
│   │   │   ├── jobs/               # Background job scheduler
│   │   │   │   ├── scheduler.go    # Job scheduling logic
│   │   │   │   └── workers/        # Background task implementations
│   │   │   ├── notify/             # Notification services
│   │   │   │   ├── email.go        # Email notifications
│   │   │   │   └── webhook.go      # Webhook notifications
│   │   │   ├── system/             # Platform self-update logic
│   │   │   │   ├── update.go       # Platform update detection
│   │   │   │   └── install.go      # Binary installation
│   │   │   ├── compose/            # Docker Compose management
│   │   │   │   ├── executor.go     # Compose command execution
│   │   │   │   └── generator.go    # Compose file generation
│   │   │   ├── caddy/              # Caddy reverse proxy integration
│   │   │   │   ├── client.go       # Caddy Admin API client
│   │   │   │   └── config.go       # Route configuration generation
│   │   │   └── health/             # Health check system
│   │   │       ├── checker.go      # Health check execution
│   │   │       └── monitor.go      # Continuous health monitoring
│   │   └── go.mod                  # Go module definition
│   └── frontend/                   # React frontend application
│       ├── src/
│       │   ├── components/         # React components
│       │   ├── pages/              # Page components
│       │   ├── hooks/              # Custom React hooks
│       │   ├── services/           # API client services
│       │   ├── stores/             # State management
│       │   └── utils/              # Utility functions
│       ├── package.json            # NPM dependencies
│       └── vite.config.ts          # Vite configuration
├── docs/                           # Documentation
│   ├── APP_PACKAGE_FORMAT.md       # Custom app package specification
│   ├── DEVELOPER_GUIDE.md          # This guide
│   ├── OPERATOR_GUIDE.md           # Operations documentation
│   └── SCRIPT_DEVELOPMENT_GUIDE.md # Script development reference
├── Dockerfile                      # Production image build
├── Makefile                        # Build automation
└── README.md                       # Project overview
```

---

## Development Environment Setup

### Prerequisites

Ensure the following tools are installed on your development system:

| Tool | Version | Purpose |
|------|---------|---------|
| Go | 1.23+ | Backend development and building |
| Node.js | 20+ | Frontend development |
| Docker | Latest | Container runtime for testing |
| Docker Compose | v2 plugin | Compose command (`docker compose`) |
| Git | Latest | Version control |
| Make | Latest | Build automation |

### Verifying Prerequisites

```bash
# Check Go version
go version

# Check Node.js version
node --version

# Check Docker availability
docker --version
docker compose version

# Verify Docker is running
docker info
```

### Initial Checkout and Dependencies

```bash
# Clone the repository
git clone https://github.com/anomalyco/LibreServ.git
cd LibreServ

# Install backend dependencies
cd server/backend
go mod download

# Install frontend dependencies
cd ../frontend
npm install
```

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

# Or build the Docker image directly
docker build -t libreserv:dev .
```

### Build Flags and Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VERSION` | Version string embedded in binary | git describe |
| `COMMIT` | Git commit hash | git rev-parse HEAD |
| `DATE` | Build timestamp | current date |
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

### Database Migrations

Migrations are stored in `server/backend/internal/database/migrations/` and follow a sequential numbering scheme.

**Creating a New Migration:**

1. Create a new SQL file with the next sequence number:
   ```
   migrations/005_add_feature_table.sql
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
- Automatic dry-run validation before applying
- Automatic rollback on failure
- Pre-migration backups created automatically

### Database Access for Development

```bash
# Start LibreServ to create the database
cd server/backend && ./bin/libreserv

# Access the SQLite database
sqlite3 /var/lib/libreserv/libreserv.db

# Or from the project directory with test data
sqlite3 /tmp/libreserv-test.db
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
# Run with debug logging
./bin/libreserv --log-level debug

# Or via environment variable
LOG_LEVEL=debug ./bin/libreserv
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
            "url": "http://localhost:5173",
            "webRoot": "${workspaceFolder}/server/frontend"
        }
    ]
}
```

### Docker Debugging

```bash
# View container logs
docker compose -f docker-compose.dev.yml logs

# Follow logs in real-time
docker logs -f libreserv-backend

# Execute shell in container
docker exec -it libreserv-backend /bin/sh

# Inspect container state
docker inspect libreserv-backend
```

---

## Architecture Overview

### Request Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│  Frontend   │────▶│   Backend   │────▶│   Docker    │
│             │◀────│   (React)   │◀────│   (Go API)  │◀────│   Compose   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                          │                   │
                          │                   │
                     ┌─────────────┐    ┌─────────────┐
                     │   Caddy     │    │  SQLite     │
                     │   (Proxy)   │    │  (Database) │
                     └─────────────┘    └─────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **Frontend** | User interface, state management, API communication |
| **Backend API** | Business logic, validation, orchestration |
| **Database** | Persistent storage, data integrity |
| **Docker Runtime** | Container lifecycle, isolation |
| **Caddy** | HTTPS termination, routing, certificates |
| **Job Scheduler** | Background tasks, periodic operations |

### Key Design Patterns

1. **Repository Pattern**: Data access abstracted through repository interfaces
2. **Service Layer**: Business logic encapsulated in service components
3. **Event Sourcing**: Audit log captures all state-changing operations
4. **Idempotent Operations**: All operations designed for safe retry

---

## API Development

### API Structure

The REST API is organized by resource:

| Resource | Base Path | Purpose |
|----------|-----------|---------|
| Apps | `/api/v1/apps` | App catalog and instance management |
| System | `/api/v1/system` | Platform operations and updates |
| Network | `/api/v1/network` | Network configuration and routing |
| Audit | `/api/v1/audit` | Audit log access |
| Jobs | `/api/v1/jobs` | Background job status |

### Adding a New Endpoint

1. **Define Handler** in `internal/api/handlers/`:

```go
// internal/api/handlers/resource.go
package handlers

import (
    "net/http"
    "github.com/gin-gonic/gin"
)

func (h *Handler) GetResource(c *gin.Context) {
    id := c.Param("id")
    resource, err := h.services.GetResource(id)
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
        return
    }
    c.JSON(http.StatusOK, resource)
}
```

2. **Register Route** in `internal/api/server.go`:

```go
func setupRoutes(r *gin.Engine) {
    api := r.Group("/api/v1")
    {
        resources := api.Group("/resources")
        {
            resources.GET("/:id", handlers.GetResource)
            resources.POST("/", handlers.CreateResource)
            resources.DELETE("/:id", handlers.DeleteResource)
        }
    }
}
```

3. **Add Tests** in `internal/api/handlers/resource_test.go`

### API Documentation

API endpoints are documented inline using OpenAPI-style comments. Generate documentation:

```bash
# Generate API docs (if swag installed)
swag init
```

---

## Frontend Development

### Project Structure

```
server/frontend/
├── src/
│   ├── components/          # Reusable UI components
│   │   ├── Button/
│   │   ├── Modal/
│   │   └── Form/
│   ├── pages/               # Route-level components
│   │   ├── Dashboard/
│   │   ├── Apps/
│   │   └── Settings/
│   ├── hooks/               # Custom React hooks
│   │   ├── useApps.ts
│   │   └── useSystem.ts
│   ├── services/            # API client
│   │   └── api.ts
│   ├── stores/              # State management (Zustand)
│   │   └── appStore.ts
│   ├── types/               # TypeScript type definitions
│   └── utils/               # Helper functions
├── package.json
├── tsconfig.json
└── vite.config.ts
```

### Development Workflow

```bash
cd server/frontend

# Start development server with HMR
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Building for production
npm run build
```

### Adding a New Page

1. Create page component in `src/pages/NewPage/`:

```tsx
// src/pages/NewPage/NewPage.tsx
import { useState } from 'react';
import { usePageTitle } from '../../hooks/usePageTitle';

export function NewPage() {
    usePageTitle('New Page');
    const [data, setData] = useState('');

    return (
        <div className="page">
            <h1>New Page</h1>
            {/* Page content */}
        </div>
    );
}
```

2. Add route in routing configuration

3. Add navigation link if applicable

---

## Docker Development

### Development Docker Compose

Create `docker-compose.dev.yml` for local development:

```yaml
version: "3.8"

services:
  backend:
    build:
      context: ./server/backend
      dockerfile: Dockerfile.dev
    ports:
      - "8080:8080"
    volumes:
      - ./server/backend:/app
      - backend-cache:/go/pkg
    environment:
      - LOG_LEVEL=debug
    depends_on:
      - caddy

  frontend:
    build:
      context: ./server/frontend
      dockerfile: Dockerfile.dev
    ports:
      - "5173:5173"
    volumes:
      - ./server/frontend:/app
      - node-modules:/app/node_modules

  caddy:
    image: caddy:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile.dev:/etc/caddy/Caddyfile
      - caddy-data:/data

volumes:
  backend-cache:
  node-modules:
  caddy-data:
```

### Building Production Image

```bash
# Build from repository root
docker build -t libreserv:latest .

# Build with specific version
docker build -t libreserv:1.0.0 --build-arg VERSION=1.0.0 .
```

---

## Code Style and Conventions

### Go Conventions

1. **Formatting**: Run `go fmt` before committing
2. **Linting**: Run `golangci-lint run` to check code quality
3. **Naming**: Use descriptive names, follow Go conventions
4. **Error Handling**: Handle errors explicitly, avoid `_`
5. **Documentation**: Comment exported types and functions

```go
// Package purpose - top of every file
// Package audit provides audit logging functionality for the platform.

// GetAuditLog retrieves the audit log with filtering options.
func GetAuditLog(ctx context.Context, filter Filter) ([]Entry, error) {
    // Implementation
}
```

### TypeScript Conventions

1. **Formatting**: ESLint and Prettier configured
2. **Types**: Prefer explicit types over `any`
3. **Components**: Functional components with hooks
4. **Naming**: camelCase for variables, PascalCase for components
5. **Imports**: Organized, grouped by type

```typescript
// Types in types/ directory
export interface AppConfig {
    id: string;
    name: string;
    version: string;
}

// Components in dedicated folders
export function AppList({ apps }: AppListProps) {
    // Implementation
}
```

### Commit Messages

Follow Conventional Commits format:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Formatting changes
- `refactor`: Code restructuring
- `test`: Test additions
- `chore`: Maintenance

---

## Contributing Guidelines

### Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/LibreServ.git
   cd LibreServ
   ```
3. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. Make changes following code conventions
5. Add tests for your changes
6. Ensure all tests pass
7. Commit with descriptive message
8. Push and create Pull Request

### Pull Request Requirements

- Clear title and description
- Link to related issue
- All CI checks passing
- Tests included for new functionality
- Documentation updated for user-facing changes
- Code follows project conventions

### Code Review Process

1. Maintainers review PR within 48 hours
2. Feedback provided as comments
3. Address review comments with additional commits
4. PR approved when all concerns resolved
5. Merge performed by maintainer

### Reporting Issues

When reporting bugs:
- Use the issue template
- Describe expected vs actual behavior
- Include steps to reproduce
- Add relevant logs and screenshots
- Note environment details (OS, Go version, etc.)
