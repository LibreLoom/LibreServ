#!/usr/bin/env bash
set -euo pipefail

# Migrate Luna Connect production data from SQLite to PostgreSQL.
#
# Run on the server as a one-time cutover step (stop luna-connect-a/b first).
#
# Required env:
#   LUNACONNECT_DATABASE_URL   postgres DSN, e.g.
#     postgres://luna_connect:SECRET@127.0.0.1:5432/luna_connect?sslmode=disable
#
# Optional env:
#   LUNACONNECT_SQLITE_PATH    default /var/lib/luna-connect/luna-connect.db
#
# Example:
#   export LUNACONNECT_DATABASE_URL='postgres://luna_connect:SECRET@127.0.0.1:5432/luna_connect?sslmode=disable'
#   sudo -E bash luna-connect/scripts/migrate-sqlite-to-postgres.sh --dry-run
#   sudo -E bash luna-connect/scripts/migrate-sqlite-to-postgres.sh
#
# After migration:
#   1. Set database.driver=postgres and database.url in both instance yaml files.
#   2. Set LUNACONNECT_JOB_LEADER=1 only on luna-connect-a (see deploy template).
#   3. systemctl restart luna-connect-a luna-connect-b

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SQLITE_PATH="${LUNACONNECT_SQLITE_PATH:-/var/lib/luna-connect/luna-connect.db}"
POSTGRES_URL="${LUNACONNECT_DATABASE_URL:-}"

if [[ -z "$POSTGRES_URL" ]]; then
  echo "LUNACONNECT_DATABASE_URL is required" >&2
  exit 2
fi
if [[ ! -f "$SQLITE_PATH" ]]; then
  echo "SQLite database not found: $SQLITE_PATH" >&2
  exit 2
fi

cd "$REPO_ROOT/luna-connect"
go build -o /tmp/luna-connect-migrate ./cmd/migrate-sqlite-to-postgres
exec /tmp/luna-connect-migrate -sqlite "$SQLITE_PATH" -postgres "$POSTGRES_URL" "$@"
