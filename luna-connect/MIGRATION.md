# SQLite → PostgreSQL migration (Luna Connect production)

Use this when moving the shared Luna Connect database from SQLite
(`/var/lib/luna-connect/luna-connect.db`) to PostgreSQL for scale.

Both blue/green instances (`luna-connect-a`, `luna-connect-b`) must use the **same**
Postgres DSN. Edit **both** config files after the data copy.

---

## Config files (exact paths)

| Instance | Config path |
|----------|-------------|
| `luna-connect-a` | `/etc/luna-connect/luna-connect-a.yaml` |
| `luna-connect-b` | `/etc/luna-connect/luna-connect-b.yaml` |

Each systemd unit loads its file via `LUNACONNECT_CONFIG` (see
`deploy/luna-connect-instance.service.tmpl`).

---

## YAML keys under `database:`

| Key | SQLite (before) | Postgres (after) |
|-----|-----------------|------------------|
| `driver` | omitted or `"sqlite"` (default) | **`"postgres"`** (required) |
| `path` | **`"/var/lib/luna-connect/luna-connect.db"`** | **remove or comment out** — not used with Postgres |
| `url` | omit or leave commented | **Postgres DSN** (required when `driver: postgres`) |

Viper env overrides (same keys, dots → underscores, prefix `LUNACONNECT_`):

| Env var | Maps to |
|---------|---------|
| `LUNACONNECT_DATABASE_DRIVER` | `database.driver` |
| `LUNACONNECT_DATABASE_URL` | `database.url` |
| `LUNACONNECT_DATABASE_PATH` | `database.path` |

You normally set these in yaml on production hosts. Env vars are optional overrides
(for example during the one-off migrate command).

---

## Before / after (copy-paste)

### Before — SQLite (default from `deploy/setup.sh`)

In **both** `/etc/luna-connect/luna-connect-a.yaml` and
`/etc/luna-connect/luna-connect-b.yaml`:

```yaml
database:
  path: "/var/lib/luna-connect/luna-connect.db"
  # Production Postgres (after migrate-sqlite-to-postgres.sh):
  # driver: "postgres"
  # url: "postgres://luna_connect:CHANGE_ME@127.0.0.1:5432/luna_connect?sslmode=disable"
```

### After — PostgreSQL

Replace the entire `database:` block in **both** files with (use your real password):

```yaml
database:
  driver: "postgres"
  url: "postgres://luna_connect:YOUR_PASSWORD@127.0.0.1:5432/luna_connect?sslmode=disable"
```

**Remove** the `path:` line when switching — do not leave both `path` and `url` active.
Commenting out `path` is fine:

```yaml
database:
  driver: "postgres"
  url: "postgres://luna_connect:YOUR_PASSWORD@127.0.0.1:5432/luna_connect?sslmode=disable"
  # path: "/var/lib/luna-connect/luna-connect.db"   # SQLite — no longer used
```

Keep the rest of each yaml file unchanged (`server`, `data_dir`, `cloudflare`, `stripe`, etc.).

---

## Migration steps

### 1. Install PostgreSQL and create role + database

On Ubuntu/Debian:

```bash
apt-get update && apt-get install -y postgresql
systemctl enable --now postgresql

DB_PASS='YOUR_STRONG_PASSWORD'
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE USER luna_connect WITH PASSWORD '${DB_PASS}';
CREATE DATABASE luna_connect OWNER luna_connect;
SQL

export LUNACONNECT_DATABASE_URL="postgres://luna_connect:${DB_PASS}@127.0.0.1:5432/luna_connect?sslmode=disable"
```

### 2. Stop both instances

```bash
sudo systemctl stop luna-connect-a luna-connect-b
```

### 3. Copy data (dry-run, then real run)

From the repo checkout on the server:

```bash
export LUNACONNECT_DATABASE_URL='postgres://luna_connect:YOUR_PASSWORD@127.0.0.1:5432/luna_connect?sslmode=disable'
# optional if SQLite is not at the default path:
# export LUNACONNECT_SQLITE_PATH='/var/lib/luna-connect/luna-connect.db'

sudo -E bash luna-connect/scripts/migrate-sqlite-to-postgres.sh --dry-run
sudo -E bash luna-connect/scripts/migrate-sqlite-to-postgres.sh
```

The script prints a ready-to-paste `database:` block using your DSN when migration succeeds.

### 4. Edit both instance yaml files

Paste the `database:` block from the script output into:

- `/etc/luna-connect/luna-connect-a.yaml`
- `/etc/luna-connect/luna-connect-b.yaml`

### 5. Restart and verify

```bash
sudo systemctl restart luna-connect-a luna-connect-b
curl -sf http://127.0.0.1:8101/healthz && echo "a ok"
curl -sf http://127.0.0.1:8102/healthz && echo "b ok"
```

### 6. Background jobs (unchanged)

Only `luna-connect-a` should run scheduled jobs. `deploy/setup.sh` drops
`/etc/systemd/system/luna-connect-a.service.d/job-leader.conf` with
`LUNACONNECT_JOB_LEADER=1`. With Postgres, advisory locks also prevent duplicate
job runs if both instances are up.

---

## Rollback

If you need to revert before deleting the SQLite file:

1. Stop both services.
2. Restore `database:` to the SQLite block (`path` only, no `driver: postgres`).
3. Start both services.

Keep `/var/lib/luna-connect/luna-connect.db` until Postgres has been verified in production.
