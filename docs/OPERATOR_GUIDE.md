# LibreServ Operator Guide

This guide is intended for system administrators managing a LibreServ instance.

---

## 1. Installation & Setup

LibreServ can be installed on any modern Linux or Darwin system.

Prerequisites for app installs:
- Docker Engine with the Compose v2 plugin (`docker compose`)
- Caddy if you want automatic HTTPS and domain routing

### One-Line Installation
The easiest way to install LibreServ is using the official installer script:

```bash
curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh
```

The script performs the following actions:
1. Detects OS and CPU Architecture.
2. Creates a `libreserv` system user and group.
3. Sets up `/opt/libreserv` for binaries and `/var/lib/libreserv` for data.
4. Downloads the latest stable binary.
5. Generates a default configuration file with secure random secrets.
6. Configures a `systemd` service (on Linux) for automatic restarts.

### Post-Installation
After installation, start the service:
```bash
sudo systemctl start libreserv
sudo systemctl enable libreserv
```

The API will be available at `http://localhost:8080` by default.

---

## 2. Update Management

LibreServ features a robust update system for both the platform and its hosted applications.

### Platform Updates
Admins can check for platform updates via the UI or API:
- **Check**: `GET /api/v1/system/updates/check`
- **Apply**: `POST /api/v1/system/updates/apply`

When an update is applied, LibreServ will:
1. Download the new binary.
2. Create a backup of the current binary (`.old`).
3. Replace the executable and restart the service automatically.

### App Updates
Apps in the catalog are checked for updates every 24 hours.
- **Automated**: Apps with `strategy: auto` will update silently without intervention.
- **Notifications**: Admins are emailed when updates are available for apps requiring manual approval.
- **Pinning**: You can lock an app to a specific version to prevent updates:
  `POST /api/v1/apps/{id}/pin`

### Update Safety
LibreServ prioritizes data safety during updates:
- **Pre-update Backups**: A full snapshot of an app's data is created before any update.
- **Atomic Migrations**: Database changes are wrapped in transactions with dry-run validation.
- **Automatic Rollback**: If an update or migration fails, the system automatically restores the previous state.

---

## 3. Reverse Proxy (Caddy)

LibreServ uses Caddy to manage SSL certificates and domain routing.

### Admin API
LibreServ communicates with Caddy via its Admin API (default: `http://localhost:2019`). Ensure Caddy is running and reachable by LibreServ.

### Route Management
Routes are automatically generated based on installed apps. You can view the current Caddyfile state via:
`GET /api/v1/network/caddyfile`

---

## 4. Audit & History

All administrative actions are recorded in the system audit log.
- **View Logs**: `GET /api/v1/audit?limit=50`
- **Update History**: `GET /api/v1/apps/updates/history`

---

## 5. Disaster Recovery

### Manual Database Restore
If the database becomes corrupted and the automatic rollback fails, you can manually restore from a pre-migration backup:

1. Stop the service: `sudo systemctl stop libreserv`
2. Locate the latest backup in `/var/lib/libreserv/`: `libreserv.db.pre-migration-YYYYMMDD-HHMMSS`
3. Replace the live DB: `cp [BACKUP_FILE] /var/lib/libreserv/libreserv.db`
4. Start the service: `sudo systemctl start libreserv`
