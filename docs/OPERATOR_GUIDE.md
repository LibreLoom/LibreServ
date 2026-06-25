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
| Podman | Latest | Latest |
| podman-compose | Latest | Latest |
| Caddy | Latest (optional) | Latest |
| Operating System | Ubuntu 20.04+ / Debian 11+ / Fedora 35+ / macOS 12+ | Ubuntu 22.04 LTS |

**Required Software:**

- **Podman**: Required for running application containers. Install from the [Podman documentation](https://podman.io/docs/installation).
- **podman-compose**: Provides the `podman compose` command. Install via your package manager or `pip`.
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
curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/install.sh | sudo sh
```

**What the Installer Does:**

1. **System Detection**: Identifies OS distribution, version, and CPU architecture
2. **User Creation**: Creates a dedicated `libreserv` system user and group
3. **Directory Setup**: Establishes required directories:
   - `/opt/libreserv` - Binary and configuration files
   - `/var/lib/libreserv` - Application data and databases
4. **Binary Download**: Fetches the latest stable binary from releases
5. **Configuration Generation**: Creates `config.yaml` with secure random secrets
6. **Service Installation**: Configures systemd service for automatic restarts (Linux)
7. **Permissions**: Sets appropriate ownership on all directories and files

**Installation Flags:**

```bash
# Install specific version
curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/install.sh | sudo sh -s -- --version 1.0.0

# Skip Caddy installation (if already installed)
curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/install.sh | sudo sh -s -- --skip-caddy

# Install to custom directory
curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/install.sh | sudo sh -s -- --prefix /custom/path
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
sudo curl -L -o libreserv https://gt.plainskill.net/LibreLoom/LibreServ/releases/latest/download/libreserv-linux-amd64
sudo chmod +x libreserv

# 4. Create configuration
sudo tee /opt/libreserv/config.yaml << 'EOF'
server:
  host: "0.0.0.0"
  port: 8080
  mode: production
database:
  path: "/var/lib/libreserv/libreserv.db"
auth:
  jwt_secret: ""
  csrf_secret: ""
  cloud_encryption_key: ""
apps:
  data_path: "/var/lib/libreserv/apps"
  catalog_path: "/opt/libreserv/catalog"
runtime:
  method: auto
  socket_path: ""
  timeout: 30s
  binary: podman
network:
  caddy:
    mode: enabled
    admin_api: "localhost:2019"
    config_path: "/etc/libreserv/caddy/Caddyfile"
    certs_path: "/etc/libreserv/caddy/certs"
    auto_https: false
logging:
  level: info
  path: "/var/log/libreserv/libreserv.log"
smtp:
  host: ""
  port: 587
  username: ""
  password: ""
  from: ""
EOF

# 5. Set ownership
sudo chown -R libreserv:libreserv /opt/libreserv /var/lib/libreserv

# 6. Create systemd service
sudo tee /etc/systemd/system/libreserv.service << 'EOF'
[Unit]
Description=LibreServ Application Platform
After=podman.service
Requires=podman.service

[Service]
Type=simple
User=libreserv
Group=libreserv
ExecStart=/opt/libreserv/libreserv --config /opt/libreserv/config.yaml
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
curl http://localhost:8080/api/v1/system/version

# Check health
curl http://localhost:8080/health

# Check Podman is accessible
podman ps

# Verify Caddy is running (if installed)
curl http://localhost:2019/config/ | head -c 200
```

**Expected Health Response:**
```json
{"status": "ok"}
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
  mode: production             # production or development

# Data and Storage
database:
  path: "/var/lib/libreserv/libreserv.db"  # SQLite database path
apps:
  data_path: "/var/lib/libreserv/apps"     # Installed app data directory
  catalog_path: "/opt/libreserv/catalog"   # App template directory
  repo_pull_interval: "6h"                 # How often to pull repo sources

# Logging
logging:
  level: "info"                # debug, info, warn, error
  path: ""                     # Optional: log file path (empty for stdout)

# Podman Configuration
runtime:
  method: "auto"               # auto, socket, tcp, ssh
  socket_path: ""              # Podman/LibreService socket (empty for default)
  tcp:
    host: ""                   # TCP Podman host
    port: 0                    # TCP Podman port
    use_tls: false
    cert_path: ""
  ssh:
    host: ""                   # SSH Podman host
    user: ""
    key_path: ""
  timeout: "30s"               # Podman operation timeout
  binary: "podman"             # Container runtime binary

# Caddy Reverse Proxy
network:
  caddy:
    mode: "disabled"           # enabled, disabled
    admin_api: "localhost:2019"  # Caddy Admin API endpoint
    config_path: "/etc/libreserv/caddy/Caddyfile"  # Caddy configuration path
    certs_path: "/etc/libreserv/caddy/certs"  # Caddy data (certificates)
    default_domain: ""         # Default domain for apps
    email: ""                  # Email for ACME registration
    auto_https: false          # Enable automatic HTTPS
    reload:
      retries: 5               # Caddy reload retry count
      backoff_min: "1s"        # Minimum backoff duration
      backoff_max: "30s"       # Maximum backoff duration
      jitter_fraction: 0.1     # Jitter for retry backoff
      attempt_timeout: "10s"   # Per-attempt timeout
    logging:
      output: "stdout"         # stdout or file
      file: ""                 # Log file path (if output: file)
      format: "console"        # console or json
      level: ""                # Log level override
  dns:
    provider: ""               # DNS provider name (e.g., "cloudflare")
    api_token: ""              # DNS provider API token
  acme:
    external:
      enabled: false           # Use external ACME issuer
      use_podman: false        # Run external ACME in Podman
      container_image: ""      # Container image for external ACME
      data_path: ""            # External ACME data directory
      dns_provider: ""         # DNS provider for external ACME
      dns_env: {}              # Environment variables for DNS provider
      email: ""                # ACME account email
      staging: false           # Use staging ACME endpoint
      ca_dir_url: ""           # Custom CA directory URL
      key_type: ""             # Key type (e.g., "P256", "P384", "RSA2048")
      certs_path: ""           # Certificate output directory

# Authentication
auth:
  jwt_secret: ""               # Generated at install. DO NOT CHANGE after setup.
  secret_file: ""              # Path to external secrets file
  csrf_secret: ""              # Generated at install. DO NOT CHANGE after setup.
  cloud_encryption_key: ""     # Key for encrypting cloud provider credentials

# Cross-Origin Resource Sharing
cors:
  allowed_origins: []          # List of allowed CORS origins

# License (optional)
license:
  entitlement_file: ""         # Path to license entitlement file
  public_key_file: ""          # Path to license public key

# SMTP (optional)
smtp:
  host: ""                     # SMTP server hostname
  port: 587                    # SMTP server port
  username: ""                 # SMTP username
  password: ""                 # SMTP password
  from: ""                     # From address
  use_tls: false               # Use TLS (true) or STARTTLS (false)
  skip_verify: false           # Skip TLS certificate verification

# Notifications (optional)
notify:
  enabled: false               # Enable email notifications
  support_recipients: []       # Recipients for support notifications
  support_subject: ""          # Support notification subject
  support_body: ""             # Support notification body
  welcome_subject: ""          # Welcome email subject
  welcome_body: ""             # Welcome email body

# Platform Updates
updates:
  base_url: "https://gt.plainskill.net/api/v1"  # Update server URL
  owner: "libreloom"           # Repository owner
  repo: "libreserv"            # Repository name
```

### Environment Variables

Override configuration using environment variables with the `LIBRESERV_` prefix and underscore-separated paths:

| Variable | Description | Default |
|----------|-------------|---------|
| `LIBRESERV_SERVER_HOST` | Server listen host | `127.0.0.1` |
| `LIBRESERV_SERVER_PORT` | Server port | `8080` |
| `LIBRESERV_SERVER_MODE` | Server mode | `production` |
| `LIBRESERV_DATABASE_PATH` | Database path | `/var/lib/libreserv/libreserv.db` |
| `LIBRESERV_LOGGING_LEVEL` | Log verbosity | `info` |
| `LIBRESERV_AUTH_JWT_SECRET` | JWT signing secret | (generated) |
| `LIBRESERV_AUTH_CSRF_SECRET` | CSRF protection secret | (generated) |
| `LIBRESERV_RUNTIME_METHOD` | Podman connection method | `auto` |
| `LIBRESERV_RUNTIME_SOCKET_PATH` | Podman socket path | (default) |
| `LIBRESERV_NETWORK_CADDY_MODE` | Caddy mode | `disabled` |
| `LIBRESERV_NETWORK_CADDY_ADMIN_API` | Caddy Admin API URL | `localhost:2019` |
| `LIBRESERV_INSECURE_DEV` | Bypass production checks (dev only) | unset |

Any config key can be overridden via environment — replace `.` with `_` and prefix with `LIBRESERV_`. For example, `network.caddy.admin_api` becomes `LIBRESERV_NETWORK_CADDY_ADMIN_API`.

### Network Configuration

**Default Network Setup:**

LibreServ creates a custom Podman bridge network (`libreserv`) for application isolation. Apps receive IP addresses from the `172.18.0.0/16` subnet by default.

**Custom Network Configuration:**

Podman network configuration is managed by Podman's own settings. LibreServ delegates all Podman networking to the Podman runtime.

**Port Allocation:**

Apps expose ports on the host. Port allocation is handled dynamically by the `PortManager` which scans upward from each app's configured default port until an available port is found.

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
./bin/libreserv --config ./configs/libreserv.yaml

# Start with dev mode (bypasses production checks)
LIBRESERV_INSECURE_DEV=true ./bin/libreserv --config ./configs/libreserv.yaml

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
2. New binary downloaded from releases
3. SHA256 checksum verified
4. Binary replaced
5. Service restarted automatically
6. Post-update health check runs — if unhealthy, rolls back automatically

**Rollback:**

```bash
# If update fails, binary automatically rolls back
# Manual rollback:
sudo systemctl stop libreserv
sudo cp /var/lib/libreserv/libreserv.old /opt/libreserv/libreserv
sudo systemctl start libreserv
```

#### Application Updates

Apps in the catalog are checked for updates periodically.

**Managing Updates:**

```bash
# View available updates
curl http://localhost:8080/api/v1/apps/updates/available

# View update history
curl http://localhost:8080/api/v1/apps/updates/history

# Check for specific app updates
curl http://localhost:8080/api/v1/apps/{instanceId}/update

# Pin app to current version (prevent updates)
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/pin

# Unpin app
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/unpin
```

### Application Management

**Installing Apps:**

```bash
# Via API
curl -X POST http://localhost:8080/api/v1/apps \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"app_id": "nextcloud", "config": {"http_port": 8080}}'

# Via UI: Navigate to Catalog, select app, click Install
```

**Starting Apps:**

```bash
# Start single app
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/start
```

**Stopping Apps:**

```bash
# Stop single app
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/stop
```

**Restarting Apps:**

```bash
# Restart app
curl -X POST http://localhost:8080/api/v1/apps/{instanceId}/restart
```

**Removing Apps:**

```bash
# Uninstall app (removes containers and data)
curl -X DELETE http://localhost:8080/api/v1/apps/{instanceId}
```

**Viewing App Status:**

```bash
# List all apps
curl http://localhost:8080/api/v1/apps

# Get app details (includes health, version, exposed info)
curl http://localhost:8080/api/v1/apps/{instanceId}

# View app status
curl http://localhost:8080/api/v1/apps/{instanceId}/status

# View app metrics (CPU, RAM, disk)
curl http://localhost:8080/api/v1/apps/{instanceId}/metrics

# Stream app logs
curl http://localhost:8080/api/v1/apps/{instanceId}/logs/stream

# View app actions
curl http://localhost:8080/api/v1/apps/{instanceId}/actions
```

### Reverse Proxy (Caddy)

LibreServ integrates with Caddy for automatic HTTPS and domain routing.

**Caddy Admin API:**

```bash
# Check Caddy status
curl http://localhost:2019/

# View Caddy config (requires Caddy API access)
curl http://localhost:2019/config/
```

**Managing Routes:**

```bash
# List all routes
curl http://localhost:8080/api/v1/network/routes

# Create a route
curl -X POST http://localhost:8080/api/v1/network/routes \
  -H "Content-Type: application/json" \
  -d '{"domain": "app.example.com", "target": "localhost:8081"}'

# Test backend connectivity before saving
curl -X POST http://localhost:8080/api/v1/network/test-backend \
  -H "Content-Type: application/json" \
  -d '{"target": "localhost:8081"}'

# Delete a route
curl -X DELETE http://localhost:8080/api/v1/network/routes/{routeID}
```

**Certificate Management:**

```bash
# Request a certificate
curl -X POST http://localhost:8080/api/v1/network/acme/request \
  -H "Content-Type: application/json" \
  -d '{"domain": "app.example.com"}'

# Check certificate job status
curl http://localhost:8080/api/v1/network/acme/jobs/{jobID}

# Get certificate issuance status
curl http://localhost:8080/api/v1/network/acme/status

# Run network probe
curl -X POST http://localhost:8080/api/v1/network/probe
```

---

## Monitoring and Logging

### System Logs

```bash
# View backend logs via journalctl
sudo journalctl -u libreserv -n 200 -f

# Or if logging to file
tail -f /var/log/libreserv/libreserv.log

# Set log level via API (runtime configurable)
```

### Audit Trail

All admin actions are logged to the audit trail.

```bash
# List audit log entries
curl http://localhost:8080/api/v1/audit
```

### Health Monitoring

```bash
# Basic health check
curl http://localhost:8080/health

# Readiness check
curl http://localhost:8080/health/ready

# Liveness check
curl http://localhost:8080/health/live

# Comprehensive system health
curl http://localhost:8080/api/v1/system/health

# Prometheus metrics endpoint
curl http://localhost:8080/metrics
```

---

## Backup and Recovery

### Automatic Backups

Scheduled backups can be configured through the web UI under Backups → Schedule.

### Manual Backups

```bash
# Create a backup
curl -X POST http://localhost:8080/api/v1/backups \
  -H "Content-Type: application/json" \
  -d '{"app_id": "your-app-instance-id"}'

# List all backups
curl http://localhost:8080/api/v1/backups

# Download a backup
curl http://localhost:8080/api/v1/backups/{backupID}/download

# Upload a backup archive
curl -X POST http://localhost:8080/api/v1/backups/upload \
  -F "file=@/path/to/backup.tar.gz"

# Database backup
curl -X POST http://localhost:8080/api/v1/backups/database

# List database backups
curl http://localhost:8080/api/v1/backups/database
```

### Restoration Procedures

```bash
# Restore an app from backup
curl -X POST http://localhost:8080/api/v1/backups/{backupID}/restore

# Restore database from backup
curl -X POST http://localhost:8080/api/v1/backups/database/{backupID}/restore
```

### Disaster Recovery

In the event of a complete system failure:

1. **Reinstall LibreServ** on fresh hardware
2. **Restore the database** from the most recent database backup via upload
3. **Reinstall apps** from the catalog
4. **Restore app data** from backup archives

---

## Security

### Security Best Practices

- Keep LibreServ updated to the latest version
- Use strong admin passwords (12+ characters)
- Configure SMTP for password reset emails
- Enable HTTPS via Caddy integration for production deployments
- Monitor security events via `/api/v1/security/events`

### Authentication and Authorization

- **JWT-based** authentication with bcrypt password hashing
- **Role-based access control**: `admin` and `user` roles
- **Rate limiting** protects against brute-force attempts:
  - Auth endpoints: 120 requests/minute (IP-based)
  - Setup endpoints: 15-180 requests/minute depending on operation
  - General API: 300 requests/minute (per user)
  - Sensitive operations (users, support, backups): 10-60 requests/minute (per user)
- **CSRF protection** on state-changing routes

### Network Security

- Security headers applied by default
- CORS with strict default policy
- Trusted proxy detection (X-Forwarded-For) respected for private subnets
- All production guardrails enforced unless `LIBRESERV_INSECURE_DEV=true` is set

---

## Troubleshooting

### Common Issues

**"Security validation failed" on startup:**
- Run with `LIBRESERV_INSECURE_DEV=true` for development, or
- Ensure production security requirements are met (secrets configured, not running as root)

**Caddy not accepting configuration:**
- Verify Caddy is running: `sudo systemctl status caddy`
- Check Caddy Admin API is accessible: `curl http://localhost:2019/`
- Check logs: `sudo journalctl -u caddy -n 50`

**App installation fails:**
- Verify Podman is running: `podman ps`
- Check app logs: ensure ports are available
- View detailed error in web UI or API response

**Cannot reach the web UI:**
- Verify the service is running: `sudo systemctl status libreserv`
- Check the configured port: `curl http://localhost:8080/health`
- Check firewall rules

### Diagnostic Commands

```bash
# Check overall system health
curl http://localhost:8080/api/v1/system/health

# Verify service is running
sudo systemctl status libreserv

# Check Podman status
podman info

# View recent logs
sudo journalctl -u libreserv -n 200

# Run network probe
curl -X POST http://localhost:8080/api/v1/network/probe
```

### Getting Help

- **Forgejo Issues**: https://gt.plainskill.net/LibreLoom/LibreServ/issues
- **Documentation**: See `docs/` directory in the repository
