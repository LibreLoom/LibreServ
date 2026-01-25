# LibreServ Operator Guide

This guide provides comprehensive instructions for system administrators responsible for installing, configuring, and managing a LibreServ instance. It covers day-to-day operations, maintenance tasks, troubleshooting, and security best practices.

## Table of Contents

- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [One-Line Installation](#one-line-installation)
  - [Manual Installation](#manual-installation)
  - [Post-Installation Verification](#post-installation-verification)
- [Configuration](#configuration)
  - [Configuration File Reference](#configuration-file-reference)
  - [Environment Variables](#environment-variables)
  - [Network Configuration](#network-configuration)
- [Operations](#operations)
  - [Service Management](#service-management)
  - [Update Management](#update-management)
  - [Application Management](#application-management)
  - [Reverse Proxy (Caddy)](#reverse-proxy-caddy)
- [Monitoring and Logging](#monitoring-and-logging)
  - [System Logs](#system-logs)
  - [Audit Trail](#audit-trail)
  - [Health Monitoring](#health-monitoring)
- [Backup and Recovery](#backup-and-recovery)
  - [Automatic Backups](#automatic-backups)
  - [Manual Backups](#manual-backups)
  - [Restoration Procedures](#restoration-procedures)
  - [Disaster Recovery](#disaster-recovery)
- [Security](#security)
  - [Security Best Practices](#security-best-practices)
  - [Authentication and Authorization](#authentication-and-authorization)
  - [Network Security](#network-security)
- [Troubleshooting](#troubleshooting)
  - [Common Issues](#common-issues)
  - [Diagnostic Commands](#diagnostic-commands)
  - [Getting Help](#getting-help)

---

## Installation

### Prerequisites

Before installing LibreServ, ensure your system meets the following requirements:

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| CPU | 1 core | 2+ cores |
| RAM | 1 GB | 2+ GB |
| Disk | 10 GB | 50+ GB |
| Docker | Latest | Latest |
| Docker Compose | v2 plugin | v2 plugin |
| Caddy | Latest (optional) | Latest |
| Operating System | Ubuntu 20.04+ / Debian 11+ / Fedora 35+ / macOS 12+ | Ubuntu 22.04 LTS |

**Required Software:**

- **Docker Engine**: Required for running application containers. Install from [Docker Official Documentation](https://docs.docker.com/engine/install/).
- **Docker Compose v2**: The `docker compose` command (not `docker-compose`). Install via Docker or your package manager.
- **Caddy** (optional): Required for automatic HTTPS and domain-based routing. Install from [Caddy Official Website](https://caddyserver.com/docs/install).

**Port Requirements:**

| Port | Service | Protocol |
|------|---------|----------|
| 80 | HTTP (Caddy) | TCP |
| 443 | HTTPS (Caddy) | TCP |
| 2019 | Caddy Admin API | TCP |
| 8080 | LibreServ API | TCP |

### One-Line Installation

The official installer script handles all installation steps automatically:

```bash
curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh
```

**What the Installer Does:**

1. **System Detection**: Identifies OS distribution, version, and CPU architecture
2. **User Creation**: Creates a dedicated `libreserv` system user and group
3. **Directory Setup**: Establishes required directories:
   - `/opt/libreserv` - Binary and configuration files
   - `/var/lib/libreserv` - Application data and databases
4. **Binary Download**: Fetches the latest stable binary from GitHub releases
5. **Configuration Generation**: Creates `config.yaml` with secure random secrets
6. **Service Installation**: Configures systemd service for automatic restarts (Linux)
7. **Permissions**: Sets appropriate ownership on all directories and files

**Installation Flags:**

```bash
# Install specific version
curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh -s -- --version 1.0.0

# Skip Caddy installation (if already installed)
curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh -s -- --skip-caddy

# Install to custom directory
curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh -s -- --prefix /custom/path
```

### Manual Installation

For environments where the automatic installer is not suitable:

```bash
# 1. Create directories
sudo mkdir -p /opt/libreserv /var/lib/libreserv

# 2. Create system user
sudo useradd --system --home /var/lib/libreserv --shell /usr/sbin/nologin libreserv

# 3. Download binary
cd /opt/libreserv
sudo curl -L -o libreserv https://github.com/anomalyco/LibreServ/releases/latest/download/libreserv-linux-amd64
sudo chmod +x libreserv

# 4. Create configuration
sudo tee /opt/libreserv/config.yaml << 'EOF'
server:
  host: "0.0.0.0"
  port: 8080
data_path: "/var/lib/libreserv"
log_level: "info"
secret_key: "$(openssl rand -base64 32)"
database:
  path: "/var/lib/libreserv/libreserv.db"
caddy:
  admin_url: "http://localhost:2019"
EOF

# 5. Set ownership
sudo chown -R libreserv:libreserv /opt/libreserv /var/lib/libreserv

# 6. Create systemd service
sudo tee /etc/systemd/system/libreserv.service << 'EOF'
[Unit]
Description=LibreServ Application Platform
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=libreserv
Group=libreserv
ExecStart=/opt/libreserv/libreserv
WorkingDirectory=/opt/libreserv
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 7. Enable and start
sudo systemctl daemon-reload
sudo systemctl enable libreserv
sudo systemctl start libreserv
```

### Post-Installation Verification

After installation, verify the system is operating correctly:

```bash
# Check service status
sudo systemctl status libreserv

# Verify API is responding
curl http://localhost:8080/api/v1/system/info

# Check Docker is accessible
docker ps

# Verify Caddy is running (if installed)
curl http://localhost:2019/config/ | head -c 200
```

**Expected API Response:**

```json
{
  "version": "1.0.0",
  "status": "running",
  "apps_installed": 0,
  "apps_running": 0
}
```

---

## Configuration

### Configuration File Reference

The primary configuration file is located at `/opt/libreserv/config.yaml`. Below is a complete reference of all configuration options:

```yaml
# Server Configuration
server:
  host: "0.0.0.0"              # Listen address (IP or hostname)
  port: 8080                   # HTTP listen port
  read_timeout: 30s            # Maximum request read timeout
  write_timeout: 30s           # Maximum request write timeout
  idle_timeout: 120s           # Maximum idle connection timeout

# Data and Storage
data_path: "/var/lib/libreserv"  # Base data directory
database:
  path: "/var/lib/libreserv/libreserv.db"  # SQLite database path
  max_open_conns: 25          # Maximum concurrent database connections
  max_idle_conns: 5           # Maximum idle database connections
  conn_max_lifetime: 5m       # Maximum connection lifetime

# Logging
log_level: "info"              # debug, info, warn, error
log_format: "json"             # json or text
log_path: ""                   # Optional: log file path (empty for stdout)

# Security
secret_key: ""                 # Generated at install, DO NOT change after setup
api_keys: []                   # Optional: additional API keys for authentication

# Docker Configuration
docker:
  socket_path: "/var/run/docker.sock"  # Docker daemon socket
  network_name: "libreserv"   # Docker network for apps
  data_volume_prefix: "libreserv-"     # Prefix for data volumes

# Caddy Reverse Proxy
caddy:
  admin_url: "http://localhost:2019"  # Caddy Admin API endpoint
  config_path: "/var/lib/libreserv/caddy"  # Caddy configuration directory
  data_path: "/var/lib/libreserv/caddy-data"  # Caddy data (certificates)

# Update Settings
updates:
  channel: "stable"           # stable, beta, or latest
  check_interval: 24h         # How often to check for updates
  auto_apply: false           # Whether to automatically apply platform updates

# Backup Configuration
backup:
  path: "/var/lib/libreserv/backups"  # Backup storage directory
  retention: 7              # Number of backups to retain
  compression: true         # Compress backup archives

# Telemetry (optional)
telemetry:
  enabled: false             # Anonymous usage statistics
  endpoint: ""               # Telemetry endpoint
```

### Environment Variables

Override configuration using environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `LIBRESERV_HOST` | Server listen host | `0.0.0.0` |
| `LIBRESERV_PORT` | Server port | `8080` |
| `LIBRESERV_DATA_PATH` | Data directory | `/var/lib/libreserv` |
| `LIBRESERV_LOG_LEVEL` | Log verbosity | `info` |
| `LIBRESERV_SECRET_KEY` | Authentication secret | (generated) |
| `DOCKER_SOCKET` | Docker socket path | `/var/run/docker.sock` |
| `CADDY_ADMIN_URL` | Caddy Admin API URL | `http://localhost:2019` |

### Network Configuration

**Default Network Setup:**

LibreServ creates a custom Docker bridge network (`libreserv`) for application isolation. Apps receive IP addresses from the `172.18.0.0/16` subnet by default.

**Custom Network Configuration:**

```yaml
docker:
  network_name: "libreserv"
  network_options:
    --subnet: "10.10.0.0/16"
    --gateway: "10.10.0.1"
    --ip-range: "10.10.1.0/24"
```

**Port Allocation:**

Apps can expose ports on the host. By default, ports 8080-9000 are available for app use. Configure allowed ports:

```yaml
app_ports:
  min: 8080
  max: 9000
```

---

## Operations

### Service Management

**Systemd Commands (Linux):**

```bash
# Check status
sudo systemctl status libreserv

# Start service
sudo systemctl start libreserv

# Stop service
sudo systemctl stop libreserv

# Restart service
sudo systemctl restart libreserv

# View recent logs
sudo journalctl -u libreserv -n 100

# Follow logs in real-time
sudo journalctl -u libreserv -f

# Enable automatic start on boot
sudo systemctl enable libreserv

# Disable automatic start
sudo systemctl disable libreserv
```

**Manual Control (macOS/Linux):**

```bash
# Start in foreground (development)
./libreserv

# Start as background daemon
./libreserv --config /opt/libreserv/config.yaml

# Stop (find and kill process)
pkill -f libreserv
```

### Update Management

#### Platform Updates

LibreServ checks for platform updates every 24 hours by default.

**Checking for Updates:**

```bash
# Via API
curl http://localhost:8080/api/v1/system/updates/check

# Via CLI (if available)
libreserv update check
```

**Applying Updates:**

```bash
# Manual update via API
curl -X POST http://localhost:8080/api/v1/system/updates/apply

# Or via systemctl (reinstall package)
sudo systemctl stop libreserv
# Replace binary at /opt/libreserv/libreserv
sudo systemctl start libreserv
```

**Update Process:**

1. Backup of current binary created at `/var/lib/libreserv/libreserv.old`
2. New binary downloaded from GitHub releases
3. SHA256 checksum verified
4. Binary replaced
5. Service restarted automatically

**Rollback:**

```bash
# If update fails, binary automatically rolls back
# Manual rollback:
sudo systemctl stop libreserv
sudo cp /var/lib/libreserv/libreserv.old /opt/libreserv/libreserv
sudo systemctl start libreserv
```

#### Application Updates

Apps in the catalog are checked for updates every 24 hours.

**Update Strategies:**

| Strategy | Behavior |
|----------|----------|
| `manual` | Admin must manually trigger updates via UI or API |
| `notify` | Admin receives notification; manual approval required |
| `auto` | Updates applied automatically without intervention |

**Managing Updates:**

```bash
# Check for app updates
curl http://localhost:8080/api/v1/apps/updates/check

# View available updates
curl http://localhost:8080/api/v1/apps/updates/available

# Apply specific update
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/update

# Pin app to current version (prevent updates)
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/pin

# Unpin app
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/unpin
```

### Application Management

**Installing Apps:**

```bash
# Via API
curl -X POST http://localhost:8080/api/v1/apps/catalog/{appId}/install \
  -H "Content-Type: application/json" \
  -d '{"config": {"http_port": 8080}}'

# Via UI: Navigate to Catalog, select app, click Install
```

**Starting Apps:**

```bash
# Start single app
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/start

# Start all stopped apps
curl -X POST http://localhost:8080/api/v1/apps/start-all
```

**Stopping Apps:**

```bash
# Stop single app
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/stop

# Stop all running apps
curl -X POST http://localhost:8080/api/v1/apps/stop-all
```

**Restarting Apps:**

```bash
# Restart with backup
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/restart

# Force restart (no backup)
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/restart?force=true
```

**Removing Apps:**

```bash
# Remove app (stop containers, keep data)
curl -X DELETE http://localhost:8080/api/v1/apps/{instanceId}

# Remove app and all data
curl -X DELETE http://localhost:8080/api/v1/apps/{instanceId}?purge=true
```

**Viewing App Status:**

```bash
# List all apps
curl http://localhost:8080/api/v1/apps

# Get app details
curl http://localhost:8080/api/v1/apps/{instanceId}

# View app logs
curl http://localhost:8080/api/v1/apps/{instanceId}/logs

# View app config
curl http://localhost:8080/api/v1/apps/{instanceId}/config
```

### Reverse Proxy (Caddy)

LibreServ integrates with Caddy for automatic HTTPS and domain routing.

**Caddy Admin API:**

```bash
# Check Caddy status
curl http://localhost:2019/

# View current configuration
curl http://localhost:2019/config/

# View running configuration
curl http://localhost:2019/config/

# Reload configuration
curl -X POST http://localhost:2019/load \
  -H "Content-Type: application/json" \
  -d @/var/lib/libreserv/caddy/Caddyfile.json
```

**Route Management:**

Routes are automatically generated based on installed apps. View the current Caddyfile:

```bash
curl http://localhost:8080/api/v1/network/caddyfile
```

**Manual Caddy Configuration:**

For custom domains and advanced routing, create a `Caddyfile` in `/var/lib/libreserv/caddy/`:

```
# /var/lib/libreserv/caddy/Caddyfile
{
    admin off
}

libreserv.example.com {
    reverse_proxy localhost:8080 {
        header_up X-Forwarded-Host libreserv.example.com
    }
}

app1.libreserv.example.com {
    reverse_proxy app1-libreserv:8080 {
        header_up X-Forwarded-Host app1.libreserv.example.com
    }
}
```

---

## Monitoring and Logging

### System Logs

**Viewing Logs:**

```bash
# All logs
journalctl -u libreserv

# Recent logs (last 100 lines)
journalctl -u libreserv -n 100

# Real-time logging
journalctl -u libreserv -f

# Logs since specific time
journalctl -u libreserv --since "2024-01-01 00:00:00"

# Error logs only
journalctl -u libreserv -p err
```

**Log Levels:**

| Level | Description | Use Case |
|-------|-------------|----------|
| `debug` | Detailed debugging information | Development and troubleshooting |
| `info` | General operational information | Default, normal operations |
| `warn` | Warning conditions | Potential issues |
| `error` | Error conditions | Problems requiring attention |

**Application Container Logs:**

```bash
# View app container logs
docker logs {instance_id}-appname

# Follow logs
docker logs -f {instance_id}-appname

# View with timestamps
docker logs --timestamps {instance_id}-appname
```

### Audit Trail

All administrative actions are recorded in the audit log.

**Querying Audit Logs:**

```bash
# Recent audit entries
curl "http://localhost:8080/api/v1/audit?limit=50"

# Filter by action type
curl "http://localhost:8080/api/v1/audit?action=app_install"

# Filter by app
curl "http://localhost:8080/api/v1/audit?app_id=myapp"

# Filter by user
curl "http://localhost:8080/api/v1/audit?user=admin"

# Filter by time range
curl "http://localhost:8080/api/v1/audit?start=2024-01-01T00:00:00Z&end=2024-01-31T23:59:59Z"
```

**Audit Log Fields:**

| Field | Description |
|-------|-------------|
| `timestamp` | When the action occurred |
| `action` | Type of action (app_install, app_update, etc.) |
| `actor` | User or system that performed the action |
| `resource` | Affected resource (app ID, instance ID) |
| `details` | Additional action details |
| `status` | Action result (success, failure) |
| `error` | Error message if action failed |

### Health Monitoring

LibreServ continuously monitors app health using configurable health checks.

**Health Check Types:**

| Type | Description |
|------|-------------|
| `http` | HTTP GET request to specified endpoint |
| `tcp` | TCP connection to specified port |
| `container` | Docker container healthcheck |
| `command` | Shell command execution |

**Viewing Health Status:**

```bash
# Overall system health
curl http://localhost:8080/api/v1/system/health

# App-specific health
curl http://localhost:8080/api/v1/apps/{instanceId}/health

# Failed health checks
curl http://localhost:8080/api/v1/apps/health/failed
```

**Configuring Health Checks:**

Health checks are defined in each app's `app.yaml`:

```yaml
health_check:
  type: http
  endpoint: /health
  port: 8080
  interval: 30s
  timeout: 10s
  retries: 3
```

---

## Backup and Recovery

### Automatic Backups

LibreServ automatically creates backups in the following scenarios:

| Trigger | Backup Type | Retention |
|---------|-------------|-----------|
| Pre-update | Full app backup | Follows retention policy |
| Scheduled (daily) | Full app backup | Follows retention policy |
| Manual request | Full app backup | Indefinite |

**Backup Location:**

All backups are stored at `/var/lib/libreserv/backups/` with the following structure:

```
/var/lib/libreserv/backups/
├── platform/
│   └── 2024-01-15T12-00-00Z/
│       ├── libreserv.db
│       └── config.yaml
└── apps/
    └── myapp/
        └── 2024-01-15T12-00-00Z/
            ├── metadata.json
            ├── data.tar.gz
            └── restore.sh
```

### Manual Backups

**Backup Platform:**

```bash
# Via API
curl -X POST http://localhost:8080/api/v1/system/backup

# Binary backup
sudo cp /opt/libreserv/libreserv /var/lib/libreserv/backups/platform/libreserv-$(date +%Y%m%d)
```

**Backup App:**

```bash
# Via API
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/backup

# View available backups
curl http://localhost:8080/api/v1/apps/{instanceId}/backups
```

### Restoration Procedures

**Restore Platform:**

```bash
# Stop service
sudo systemctl stop libreserv

# Restore database
sudo cp /var/lib/libreserv/backups/platform/2024-01-15T12-00-00Z/libreserv.db \
  /var/lib/libreserv/libreserv.db

# Restore binary (if needed)
sudo cp /var/lib/libreserv/backups/platform/libreserv-old \
  /opt/libreserv/libreserv

# Start service
sudo systemctl start libreserv
```

**Restore App:**

```bash
# Via API
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/restore \
  -H "Content-Type: application/json" \
  -d '{"backup_id": "backup-2024-01-15-120000"}'

# To different instance ID
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/restore \
  -H "Content-Type: application/json" \
  -d '{"backup_id": "backup-2024-01-15-120000", "new_instance_id": "myapp-restored"}'
```

### Disaster Recovery

#### Complete System Recovery

1. **Assess Damage**: Identify which components are affected
2. **Restore Docker**: Ensure Docker is operational
3. **Restore Platform**: Recover LibreServ binary and configuration
4. **Restore Database**: Import last known good database
5. **Restore Apps**: Reinstall or restore apps from backups
6. **Verify**: Test each component systematically

**Scripted Recovery:**

```bash
#!/bin/bash
# disaster-recovery.sh

BACKUP_DATE="${1:-$(ls -t /var/lib/libreserv/backups/platform/ | head -1)}"
BACKUP_PATH="/var/lib/libreserv/backups/platform/${BACKUP_DATE}"

echo "Starting disaster recovery from ${BACKUP_DATE}"

# Stop LibreServ
systemctl stop libreserv

# Restore database
cp "${BACKUP_PATH}/libreserv.db" /var/lib/libreserv/libreserv.db

# Restore Caddy data
cp -r "${BACKUP_PATH}/caddy-data/"* /var/lib/libreserv/caddy-data/

# Restart services
systemctl start libreserv

echo "Disaster recovery complete"
```

#### Manual Database Restore

If automatic rollback fails and database is corrupted:

```bash
# 1. Stop the service
sudo systemctl stop libreserv

# 2. List available backups
ls -la /var/lib/libreserv/libreserv.db.pre-*

# 3. Copy latest backup
sudo cp /var/lib/libreserv/libreserv.db.pre-migration-YYYYMMDD-HHMMSS \
  /var/lib/libreserv/libreserv.db

# 4. Set correct ownership
sudo chown libreserv:libreserv /var/lib/libreserv/libreserv.db

# 5. Start the service
sudo systemctl start libreserv
```

---

## Security

### Security Best Practices

1. **Keep Updated**: Apply platform and app updates promptly
2. **Strong Secrets**: Use generated random secrets; don't hardcode
3. **Network Isolation**: Use firewall to limit access to management ports
4. **Regular Backups**: Maintain and test backup restoration regularly
5. **Audit Monitoring**: Review audit logs regularly for suspicious activity
6. **Least Privilege**: Run apps with minimal required permissions
7. **SSL/TLS**: Always use HTTPS in production (Caddy handles this)
8. **Access Control**: Limit who can access the management interface

### Authentication and Authorization

**Default Authentication:**

LibreServ uses API key authentication. The primary API key is generated during installation and stored in the configuration file.

**Adding Additional API Keys:**

```yaml
api_keys:
  - name: "backup-service"
    key: "ak_xxxxxxxxxxxxxxxxxxxxxxxx"
    permissions:
      - "apps:read"
      - "apps:backup"
  - name: "monitoring"
    key: "ak_yyyyyyyyyyyyyyyyyyyy"
    permissions:
      - "apps:read"
      - "system:read"
```

**API Key Usage:**

```bash
# Authenticated request
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:8080/api/v1/apps
```

### Network Security

**Firewall Configuration (UFW):**

```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow LibreServ API (restrict to trusted network)
sudo ufw allow from 10.0.0.0/8 to any port 8080

# Enable firewall
sudo ufw enable
```

**Docker Network Security:**

```bash
# Create isolated network
docker network create --driver bridge \
  --subnet 172.20.0.0/16 \
  --gateway 172.20.0.1 \
  libreserv-internal

# Apps can only communicate within their network
```

---

## Troubleshooting

### Common Issues

**Service Won't Start:**

```bash
# Check for port conflicts
netstat -tlnp | grep 8080

# Check Docker is running
systemctl status docker

# Check logs for errors
journalctl -u libreserv --no-pager | tail -50
```

**Docker Permission Denied:**

```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Or use sudo for docker commands
sudo docker ps
```

**App Container Crashing:**

```bash
# Check container logs
docker logs {instance_id}-appname

# Check container events
docker events --filter container={instance_id}-appname

# Inspect container state
docker inspect {instance_id}-appname
```

**Caddy Not Routing:**

```bash
# Check Caddy status
curl http://localhost:2019/

# Verify Caddyfile is valid
cd /var/lib/libreserv/caddy
caddy validate --config Caddyfile

# Check Caddy logs
docker logs caddy
```

**Database Corruption:**

```bash
# Check database integrity
sqlite3 /var/lib/libreserv/libreserv.db "PRAGMA integrity_check"

# Restore from backup
# See Disaster Recovery section
```

### Diagnostic Commands

```bash
# System information
curl http://localhost:8080/api/v1/system/info

# Disk usage
df -h /var/lib/libreserv

# Docker disk usage
docker system df

# Container resource usage
docker stats --no-stream

# Network connectivity test
curl -v http://localhost:8080/api/v1/health

# App list with status
curl http://localhost:8080/api/v1/apps | jq '.[] | {name: .name, status: .status}'
```

### Getting Help

If you cannot resolve an issue:

1. **Check Documentation**: Review this guide and related docs in `/docs/`
2. **Check Logs**: Review system and application logs for error messages
3. **Search Issues**: Check GitHub issues for similar problems
4. **Create Issue**: Report new issues at https://github.com/anomalyco/LibreServ/issues
   - Include: OS, LibreServ version, Docker version, relevant logs, steps to reproduce
