# LibreServ Developer Guide

This guide covers building, testing, and extending the LibreServ backend.

## Project Structure

- `server/backend`: Go backend source code.
  - `cmd/libreserv`: Main entry point.
  - `internal/api`: HTTP server and handlers.
  - `internal/apps`: App catalog and lifecycle management.
  - `internal/audit`: System audit logging.
  - `internal/database`: SQLite and migration logic.
  - `internal/jobs`: Background scheduler.
  - `internal/notify`: Notification services.
  - `internal/system`: Platform self-update logic.
- `server/frontend`: React (Vite) frontend source.
- `docs/`: Documentation and guides.

## Building from Source

### Prerequisites
- Go 1.23+
- Node.js 20+
- Docker & Docker Compose

### Commands
Use the provided `Makefile` in `server/backend`:

```bash
# Build backend with version injection
make build

# Build frontend
make frontend-build
```

## Database Migrations

LibreServ uses an embedded migration system.
1. Add a new `.sql` file to `server/backend/internal/database/migrations/`.
2. Name it with a prefix (e.g., `005_feature_name.sql`).
3. The system will automatically detect and run it on next startup.

*Note: Migrations run in transactions and include automatic dry-run validation.*

## Testing

Run all tests from the `server/backend` directory:
```bash
go test -v ./...
```

To test app update logic specifically:
```bash
go test -v ./internal/apps/ -run TestUpdateHistory
```

## Docker

A multi-stage `Dockerfile` is provided in the root directory to build a production-ready image containing both frontend and backend.

```bash
docker build -t libreserv:latest .
```
