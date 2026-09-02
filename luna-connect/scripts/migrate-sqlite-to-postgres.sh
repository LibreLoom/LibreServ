#!/usr/bin/env bash
set -euo pipefail

# Migrate Luna Connect production data from SQLite to PostgreSQL.
#
# Prerequisites (this script does NOT install Postgres):
#   1. PostgreSQL running locally (or reachable from this host).
#   2. Empty database + user created (see --help for Ubuntu/Debian commands).
#   3. luna-connect-a and luna-connect-b stopped during the real migration.
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
#   sudo systemctl stop luna-connect-a luna-connect-b
#   sudo -E bash luna-connect/scripts/migrate-sqlite-to-postgres.sh --dry-run
#   sudo -E bash luna-connect/scripts/migrate-sqlite-to-postgres.sh
#
# After migration, edit BOTH:
#   /etc/luna-connect/luna-connect-a.yaml
#   /etc/luna-connect/luna-connect-b.yaml
# See MIGRATION.md or the yaml block printed when migration completes.

usage() {
  cat <<'EOF'
migrate-sqlite-to-postgres.sh — copy Luna Connect data from SQLite to PostgreSQL.

This script copies data only. You must install and configure PostgreSQL first.
Full runbook: luna-connect/MIGRATION.md

Prerequisites
  - PostgreSQL server running (local or remote).
  - Database user and empty database created.
  - Existing SQLite file (default: /var/lib/luna-connect/luna-connect.db).
  - Stop luna-connect-a and luna-connect-b before the real migration (not dry-run).

Quick setup on Ubuntu/Debian (run as root):

  apt-get update && apt-get install -y postgresql
  systemctl enable --now postgresql

  # Pick a strong password and substitute below:
  DB_PASS='CHANGE_ME'
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
  CREATE USER luna_connect WITH PASSWORD '${DB_PASS}';
  CREATE DATABASE luna_connect OWNER luna_connect;
  SQL

  export LUNACONNECT_DATABASE_URL="postgres://luna_connect:${DB_PASS}@127.0.0.1:5432/luna_connect?sslmode=disable"

Usage
  export LUNACONNECT_DATABASE_URL='postgres://luna_connect:SECRET@127.0.0.1:5432/luna_connect?sslmode=disable'
  sudo systemctl stop luna-connect-a luna-connect-b
  sudo -E bash luna-connect/scripts/migrate-sqlite-to-postgres.sh --dry-run
  sudo -E bash luna-connect/scripts/migrate-sqlite-to-postgres.sh

Environment
  LUNACONNECT_DATABASE_URL   (required) Postgres connection URL
                               → yaml key database.url
  LUNACONNECT_SQLITE_PATH      (optional) SQLite file path
                               → source file; not the yaml database.path after switch

Viper env overrides (optional; production normally uses yaml):
  LUNACONNECT_DATABASE_DRIVER  → database.driver   (set "postgres" after migration)
  LUNACONNECT_DATABASE_URL     → database.url
  LUNACONNECT_DATABASE_PATH    → database.path     (SQLite only — remove after switch)

Config files to edit after migration (both instances, same database: block):

  /etc/luna-connect/luna-connect-a.yaml
  /etc/luna-connect/luna-connect-b.yaml

Before (SQLite — default from deploy/setup.sh):

  database:
    path: "/var/lib/luna-connect/luna-connect.db"

After (PostgreSQL — paste into BOTH files; remove or comment path):

  database:
    driver: "postgres"
    url: "postgres://luna_connect:SECRET@127.0.0.1:5432/luna_connect?sslmode=disable"

Then:

  sudo systemctl restart luna-connect-a luna-connect-b

The migrate command prints an exact database: block using your LUNACONNECT_DATABASE_URL
when the copy finishes successfully.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SQLITE_PATH="${LUNACONNECT_SQLITE_PATH:-/var/lib/luna-connect/luna-connect.db}"
POSTGRES_URL="${LUNACONNECT_DATABASE_URL:-}"

for arg in "$@"; do
  case "$arg" in
    -h|--help|help)
      usage
      exit 0
      ;;
  esac
done

if [[ -z "$POSTGRES_URL" ]]; then
  cat >&2 <<'EOF'
LUNACONNECT_DATABASE_URL is required.

This migration copies your existing SQLite database into PostgreSQL — it does
not install or start Postgres for you. Set up PostgreSQL first, then export:

  export LUNACONNECT_DATABASE_URL='postgres://luna_connect:YOUR_PASSWORD@127.0.0.1:5432/luna_connect?sslmode=disable'

Run with --help for full Ubuntu/Debian setup commands and yaml paths.
See luna-connect/MIGRATION.md for the full runbook.
EOF
  exit 2
fi

if [[ ! -f "$SQLITE_PATH" ]]; then
  echo "SQLite database not found: $SQLITE_PATH" >&2
  echo "Set LUNACONNECT_SQLITE_PATH if your file is elsewhere." >&2
  exit 2
fi

cd "$REPO_ROOT/luna-connect"
go build -o /tmp/luna-connect-migrate ./cmd/migrate-sqlite-to-postgres
exec /tmp/luna-connect-migrate -sqlite "$SQLITE_PATH" -postgres "$POSTGRES_URL" "$@"
