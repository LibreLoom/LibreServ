# App Package Format

This document describes the format for custom app packages that can be uploaded to LibreServ.

## Overview

Custom apps are distributed as XZ-compressed tar archives (`.tar.xz`). They contain the same structure as built-in apps but are uploaded by users.

## Archive Structure

```
app-name-version.tar.xz
├── app.yaml                    # Required: App metadata
├── app-compose/                # Required: Docker environment
│   └── docker-compose.yml      # Required: Compose file
└── scripts/                    # Optional: Scripts directory
    ├── system-setup            # Optional: Initial setup
    ├── system-update           # Optional: Update logic
    ├── system-repair           # Optional: Auto-repair
    ├── system-backup           # Optional: Custom backup
    ├── system-restore          # Optional: Custom restore
    ├── action-name             # Optional: User action
    └── action-name.opts        # Optional: Action options
```

## Required Files

### app.yaml
The main app metadata file. See [App YAML Schema](#app-yaml-schema).

### app-compose/docker-compose.yml
Docker Compose file defining the app's services. Template variables are supported:

```yaml
services:
  app:
    image: myapp:latest
    ports:
      - "{{.http_port}}:8080"
    volumes:
      - "{{ dataPath }}/data:/data"
    environment:
      - PORT=8080
```

Available template variables:
- `{{.instance_id}}` - Unique instance ID
- `{{.app_name}}` - User-provided or default name
- `{{.install_path}}` - Installation directory
- `{{.dataPath}}` - Data directory (inside app-compose)
- `{{.http_port}}` - User-configured HTTP port
- Any user-configured option

## Optional Files

### Scripts
See [Script Development Guide](SCRIPT_DEVELOPMENT_GUIDE.md) for script requirements.

### Action Options (.opts files)
See [Script Development Guide](SCRIPT_DEVELOPMENT_GUIDE.md#defining-options) for options schema.

## App YAML Schema

```yaml
id: myapp                    # Required: Unique ID (lowercase, alphanumeric, hyphens)
name: My App                 # Required: Display name
description: "My application"  # Required: Description
version: "1.0.0"             # Required: Version string
category: utility            # Required: Category (productivity/media/development/utility/ai/search/storage/security/other)
icon: ""                     # Optional: URL to icon
website: ""                  # Optional: Project website
repository: ""               # Optional: Repository URL
featured: false              # Optional: Featured in catalog

deployment:
  compose_file: docker-compose.yml  # Required: Path to compose file
  image: ""              # Optional: Direct image reference (alternative to compose)
  ports:                 # Optional: Default port mappings
    - host: 8080
      container: 8080
      protocol: tcp
      name: ui
  volumes:               # Optional: Default volumes
    - name: data
      mount_path: /app/data
  environment: {}         # Optional: Default environment variables
  labels: {}             # Optional: Container labels
  network_mode: ""       # Optional: Docker network mode
  restart_policy: unless-stopped  # Optional: Restart policy
  depends_on: []         # Optional: Service dependencies
  backends:              # Optional: Internal backend URLs
    - name: api
      url: "http://localhost:9000"

configuration:            # Optional: User-configurable fields
  - name: http_port
    label: HTTP Port
    type: port
    default: 8080
    required: true
  - name: admin_password
    label: Admin Password
    type: password
    required: true

health_check:             # Optional: Health check configuration
  type: http              # http/tcp/container/command
  endpoint: /health       # For HTTP checks
  port: 8080              # For TCP checks
  interval: 30s           # Check interval
  timeout: 10s            # Check timeout
  retries: 3              # Retries before unhealthy

requirements:             # Optional: System requirements
  min_ram: "512M"         # Minimum RAM
  min_cpu: 0.5            # Minimum CPU cores
  min_disk: "1G"          # Minimum disk space
  arch:                   # Supported architectures
    - amd64
    - arm64

updates:                  # Optional: Update behavior
  strategy: notify        # manual/notify/auto
  backup_before_update: true
  allow_downgrade: false

scripts:                  # Optional: Script definitions
  system:
    setup: scripts/system-setup
    update: scripts/system-update
    repair: scripts/system-repair
    backup: scripts/system-backup
    restore: scripts/system-restore
  actions:
    - name: logs
      label: "View Logs"
      script: scripts/view-logs
      confirm: false
```

## Upload Process

1. User uploads `.tar.xz` file via UI or API
2. Backend validates archive structure
3. Extracts to temporary location
4. Validates `app.yaml` and `docker-compose.yml`
5. Scans for scripts and options files
6. Adds app to catalog as `AppTypeCustom`
7. App appears in catalog for installation

## Example Custom App

### Structure
```
myapp-1.0.0.tar.xz/
├── app.yaml
├── app-compose/
│   └── docker-compose.yml
└── scripts/
    ├── system-setup
    ├── configure
    └── configure.opts
```

### app.yaml
```yaml
id: myapp
name: My Custom App
description: "A custom app for testing"
version: "1.0.0"
category: utility

deployment:
  compose_file: docker-compose.yml
  ports:
    - host: 8080
      container: 8080

configuration:
  - name: http_port
    label: HTTP Port
    type: port
    default: 8080

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
      - "{{ dataPath }}/data:/data"
    restart: unless-stopped
```

## Restrictions

- App ID must be unique (no duplicates with built-in apps)
- Compose file must be valid
- Scripts must be executable
- Options files must be valid YAML
- Total archive size limit: 100MB (configurable)
