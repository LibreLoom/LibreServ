# App Package Format

This document provides the complete specification for custom application packages that can be uploaded to and managed by LibreServ.

## Table of Contents

- [Overview](#overview)
- [Archive Structure](#archive-structure)
- [Required Components](#required-components)
  - [app.yaml](#appyaml)
  - [docker-compose.yml](#docker-composeyml)
- [Optional Components](#optional-components)
  - [System Scripts](#system-scripts)
  - [Action Scripts](#action-scripts)
  - [Action Options Files](#action-options-files)
- [app.yaml Schema Reference](#app-yaml-schema-reference)
  - [Metadata Section](#metadata-section)
  - [Deployment Section](#deployment-section)
  - [Configuration Section](#configuration-section)
  - [Health Check Section](#health-check-section)
  - [Requirements Section](#requirements-section)
  - [Updates Section](#updates-section)
  - [Scripts Section](#scripts-section)
- [Template Variables](#template-variables)
- [Upload Process](#upload-process)
- [Complete Example](#complete-example)
- [Restrictions and Limitations](#restrictions-and-limitations)

---

## Overview

Custom applications in LibreServ are distributed as **XZ-compressed tar archives** (`.tar.xz` format). These packages contain all necessary files to define, configure, and deploy an application within the LibreServ ecosystem. The package structure mirrors that of built-in applications, ensuring consistent handling across the platform.

Custom apps uploaded to LibreServ are tracked as `AppTypeCustom` in the system, distinguishing them from pre-built applications in the official catalog. This separation allows administrators to manage custom and built-in apps through the same interfaces while maintaining clear provenance.

---

## Archive Structure

The following directory structure defines how files must be organized within the archive:

```
app-name-version.tar.xz
├── app.yaml                              # Required: Application metadata and configuration
├── app-compose/                          # Required: Docker Compose environment
│   └── docker-compose.yml                # Required: Docker Compose service definition
└── scripts/                              # Optional: Lifecycle and action scripts
    ├── system-setup                      # Optional: Initial setup (runs once on first install)
    ├── system-update                     # Optional: Pre-update operations
    ├── system-repair                     # Optional: Auto-repair on health failure
    ├── system-backup                     # Optional: Custom backup creation
    ├── system-restore                    # Optional: Custom restore operations
    ├── action-name                       # Optional: User-facing action script
    └── action-name.opts                  # Optional: Action configuration and options
```

The archive filename follows the pattern `app-id-version.tar.xz` where:
- `app-id` is the unique identifier from `app.yaml`
- `version` is the semantic version from `app.yaml`

---

## Required Components

### app.yaml

The `app.yaml` file is the mandatory manifest that describes your application. It contains all metadata, deployment configuration, and behavioral definitions. See the [app.yaml Schema Reference](#app-yaml-schema-reference) for the complete specification.

### docker-compose.yml

Located at `app-compose/docker-compose.yml`, this file defines the Docker services that run your application. LibreServ uses Docker Compose to orchestrate container lifecycle, networking, and volume management.

The Compose file supports template variables that are substituted during deployment:

```yaml
version: "3.8"

services:
  app:
    image: myapp:latest
    container_name: "{{.instance_id}}-myapp"
    ports:
      - "{{.http_port}}:8080"
    volumes:
      - "{{.dataPath}}/data:/data"
    restart: unless-stopped
    environment:
      - PORT=8080
      - APP_NAME={{.app_name}}
      - INSTANCE_ID={{.instance_id}}
```

---

## Optional Components

### System Scripts

System scripts are executable files that automate operations during specific lifecycle events. They must be placed in the `scripts/` directory and have executable permissions (`chmod +x`). See the [Script Development Guide](SCRIPT_DEVELOPMENT_GUIDE.md) for complete documentation.

| Script | Purpose | When It Runs |
|--------|---------|--------------|
| `system-setup` | One-time initialization tasks | After first successful container start |
| `system-update` | Pre-update operations | Before containers are recreated during updates |
| `system-repair` | Automated recovery | When health check fails N consecutive times |
| `system-backup` | Create backup snapshots | Before updates and scheduled backups |
| `system-restore` | Restore from backups | When restoring app from backup |

### Action Scripts

Action scripts expose user-facing operations through the LibreServ UI. Users can execute these actions on demand, with optional configurable parameters. Each action consists of:
- An executable script file in `scripts/`
- An optional `.opts` file defining UI presentation and options

### Action Options Files

Action options files (`.opts`) define how an action appears in the UI and what parameters users can configure. They use YAML format with sections for metadata, options, and execution settings.

---

## app.yaml Schema Reference

### Metadata Section

The metadata section defines fundamental application properties:

```yaml
id: myapp                                    # REQUIRED: Unique lowercase ID (alphanumeric and hyphens only)
name: My App                                 # REQUIRED: Human-readable display name
description: "My application description"    # REQUIRED: Brief description shown in catalog
version: "1.0.0"                             # REQUIRED: Semantic version string
category: utility                            # REQUIRED: Category (productivity/media/development/utility/ai/search/storage/security/other)
icon: ""                                     # OPTIONAL: URL to app icon (PNG/SVG, 128x128px recommended)
website: ""                                  # OPTIONAL: Project website URL
repository: ""                               # OPTIONAL: Source code repository URL
featured: false                              # OPTIONAL: Feature in catalog (admin-controlled)
```

**Category Values:**

| Category | Description |
|----------|-------------|
| `productivity` | Office, collaboration, and productivity tools |
| `media` | Media servers, streaming, and entertainment |
| `development` | IDEs, code repositories, CI/CD tools |
| `utility` | General utilities and system tools |
| `ai` | Machine learning and AI applications |
| `search` | Search engines and indexing tools |
| `storage` | File storage and backup solutions |
| `security` | Security, authentication, and monitoring |
| `other` | Applications not fitting other categories |

### Deployment Section

The deployment section specifies how the application runs:

```yaml
deployment:
  compose_file: docker-compose.yml           # REQUIRED: Path to compose file relative to archive root
  image: ""                                  # OPTIONAL: Direct image reference (alternative to compose services)
  ports:                                     # OPTIONAL: Default port mappings
    - host: 8080                             # Host port
      container: 8080                        # Container port
      protocol: tcp                          # Protocol (tcp/udp)
      name: ui                               # Logical name for the port
  volumes:                                   # OPTIONAL: Named volumes to create
    - name: data                             # Volume name
      mount_path: /app/data                  # Container mount path
  environment: {}                            # OPTIONAL: Default environment variables
  labels: {}                                 # OPTIONAL: Docker container labels
  network_mode: ""                           # OPTIONAL: Docker network mode (bridge/host/none)
  restart_policy: unless-stopped             # OPTIONAL: Container restart policy (no/always/on-failure/unless-stopped)
  depends_on: []                             # OPTIONAL: Service dependencies for startup order
  backends:                                  # OPTIONAL: Internal backend URLs available to app
    - name: api                              # Backend name for reference
      url: "http://localhost:9000"           # Backend URL
```

**Restart Policy Values:**

| Policy | Behavior |
|--------|----------|
| `no` | Do not restart container on exit |
| `always` | Always restart container |
| `on-failure` | Restart only on non-zero exit code |
| `unless-stopped` | Restart unless explicitly stopped |

### Configuration Section

The configuration section defines user-configurable options that appear in the installation UI:

```yaml
configuration:                               # OPTIONAL: User-configurable fields
  - name: http_port                          # REQUIRED: Option identifier (lowercase with underscores)
    label: HTTP Port                         # REQUIRED: UI label
    type: port                               # REQUIRED: Data type (string/number/boolean/password/port)
    default: 8080                            # OPTIONAL: Default value
    required: true                           # OPTIONAL: Whether user must provide value
    min: 1024                                # OPTIONAL: Minimum value (for number/port)
    max: 65535                               # OPTIONAL: Maximum value (for number/port)
    description: "Port for HTTP access"      # OPTIONAL: Help text shown in UI
```

**Configuration Type Values:**

| Type | Description | Validation |
|------|-------------|------------|
| `string` | Text input | Basic string length limits |
| `number` | Numeric input | Numeric range validation |
| `boolean` | Toggle switch | True/false |
| `password` | Secret input | Masked in UI, not logged |
| `port` | Port number | 1-65535, must be available |

### Health Check Section

The health check section configures how LibreServ monitors application health:

```yaml
health_check:                                # OPTIONAL: Health monitoring configuration
  type: http                                 # REQUIRED: Check type (http/tcp/container/command)
  endpoint: /health                          # OPTIONAL: HTTP path for checks (type: http)
  port: 8080                                 # OPTIONAL: Port for TCP checks (type: tcp)
  interval: 30s                              # OPTIONAL: Check interval (default: 30s)
  timeout: 10s                               # OPTIONAL: Response timeout (default: 10s)
  retries: 3                                 # OPTIONAL: Consecutive failures before unhealthy (default: 3)
```

**Health Check Types:**

| Type | Description | Configuration |
|------|-------------|---------------|
| `http` | HTTP GET request | Requires `endpoint` |
| `tcp` | TCP connection | Requires `port` |
| `container` | Docker healthcheck | Uses container's HEALTHCHECK |
| `command` | Shell command | Requires `command` string |

### Requirements Section

The requirements section specifies minimum system resources:

```yaml
requirements:                                # OPTIONAL: System requirements
  min_ram: "512M"                            # OPTIONAL: Minimum RAM (e.g., "512M", "1G")
  min_cpu: 0.5                               # OPTIONAL: Minimum CPU cores (decimal allowed)
  min_disk: "1G"                             # OPTIONAL: Minimum disk space
  arch:                                      # OPTIONAL: Supported CPU architectures
    - amd64                                  # 64-bit x86
    - arm64                                  # 64-bit ARM
```

### Updates Section

The updates section controls update behavior:

```yaml
updates:                                     # OPTIONAL: Update configuration
  strategy: notify                           # REQUIRED: Update strategy (manual/notify/auto)
  backup_before_update: true                 # OPTIONAL: Create backup before updates (default: true)
  allow_downgrade: false                     # OPTIONAL: Allow version downgrade (default: false)
```

**Update Strategy Values:**

| Strategy | Behavior |
|----------|----------|
| `manual` | Admin must manually trigger updates |
| `notify` | Admin notified of updates, manual approval required |
| `auto` | Updates applied automatically without intervention |

### Scripts Section

The scripts section maps lifecycle events and actions to script files:

```yaml
scripts:                                     # OPTIONAL: Script definitions
  system:                                    # System scripts
    setup: scripts/system-setup              # Path to setup script
    update: scripts/system-update            # Path to update script
    repair: scripts/system-repair            # Path to repair script
    backup: scripts/system-backup            # Path to backup script
    restore: scripts/system-restore          # Path to restore script
  actions:                                   # Action scripts
    - name: logs                             # Action identifier
      label: "View Logs"                     # UI label
      script: scripts/view-logs              # Path to script
      confirm: false                         # OPTIONAL: Require confirmation before execution
```

---

## Template Variables

The following template variables are available for use in `docker-compose.yml`:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{.instance_id}}` | Unique instance identifier | `abc123def456` |
| `{{.app_name}}` | User-provided app name | `My App` |
| `{{.install_path}}` | Installation directory | `/var/lib/libreserv/apps/abc123` |
| `{{.dataPath}}` | App data directory | `/var/lib/libreserv/apps/abc123/data` |
| `{{.http_port}}` | User-configured HTTP port | `8080` |
| `{{.option_name}}` | Any configuration option | `{{.admin_password}}` |

---

## Upload Process

The following steps occur when uploading a custom app package:

1. **Upload**: User submits `.tar.xz` file via LibreServ UI or API
2. **Archive Validation**: Backend verifies file format (XZ-compressed tar) and basic structure
3. **Extraction**: Archive extracted to temporary location for inspection
4. **Schema Validation**: `app.yaml` validated against schema requirements
5. **Compose Validation**: `docker-compose.yml` syntax and service definitions validated
6. **Script Discovery**: Scripts and options files scanned and registered
7. **Catalog Entry**: App added to database as `AppTypeCustom`
8. **Availability**: App appears in catalog for installation

---

## Complete Example

### Archive Structure

```
myapp-1.0.0.tar.xz/
├── app.yaml
├── app-compose/
│   └── docker-compose.yml
└── scripts/
    ├── system-setup
    ├── system-backup
    └── configure
```

### app.yaml

```yaml
id: myapp
name: My Custom App
description: "A custom app demonstrating package format"
version: "1.0.0"
category: utility

deployment:
  compose_file: docker-compose.yml
  ports:
    - host: 8080
      container: 8080
      protocol: tcp
      name: http

configuration:
  - name: http_port
    label: HTTP Port
    type: port
    default: 8080
    required: true
  - name: admin_password
    label: Admin Password
    type: password
    required: true

health_check:
  type: http
  endpoint: /
  port: 8080
  interval: 30s
  timeout: 5s
  retries: 3

updates:
  strategy: notify
  backup_before_update: true

scripts:
  system:
    setup: scripts/system-setup
    backup: scripts/system-backup
  actions:
    - name: configure
      label: "Configure"
      script: scripts/configure
```

### docker-compose.yml

```yaml
version: "3.8"

services:
  myapp:
    image: myapp:latest
    container_name: "{{.instance_id}}-myapp"
    ports:
      - "{{.http_port}}:8080"
    volumes:
      - "{{.dataPath}}/data:/data"
      - "{{.dataPath}}/config:/config"
    restart: unless-stopped
    environment:
      - PORT=8080
      - ADMIN_PASSWORD={{.admin_password}}
```

---

## Restrictions and Limitations

- **Unique ID**: App ID must not conflict with existing built-in apps
- **Valid Compose**: `docker-compose.yml` must be syntactically valid
- **Executable Scripts**: All script files must have executable permissions
- **Valid Options**: `.opts` files must contain valid YAML
- **Archive Size**: Total uncompressed archive size limited to 100MB (configurable per deployment)
- **No Root in Compose**: Services should not run as UID 0 in containers
- **Volume Isolation**: Data volumes are isolated per app instance
- **Network Isolation**: Apps run on a custom bridge network by default
