# Script Development Guide

This guide explains how to create scripts for LibreServ apps. Scripts are executable programs that extend app functionality and can be exposed through the UI.

## Script System Overview

LibreServ supports two types of scripts:

1. **System Scripts** (`system-*`): Automated operations that run during specific lifecycle events
2. **Action Scripts**: User-facing operations exposed in the UI

## Folder Structure

```
app-name/
├── app.yaml              # App metadata (required)
├── app-compose/          # Docker environment
│   └── docker-compose.yml
└── scripts/              # Scripts directory
    ├── system-setup      # Initial setup (first install only)
    ├── system-update     # Update app version
    ├── system-repair     # Auto-repair on health failure
    ├── system-backup     # Create backup
    ├── system-restore    # Restore from backup
    ├── action-name       # User-facing action
    └── action-name.opts  # Options definition (optional)
```

## System Scripts

### system-setup
**When it runs:** Once, after the app container is confirmed fully started (first install only)

**Purpose:** One-time initialization tasks like:
- Creating directories
- Generating secrets
- Setting up initial data
- Database migrations

**Example:**
```bash
#!/bin/bash
set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required"
    exit 1
fi

# Parse config using jq
APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")
INSTALL_PATH=$(jq -r '.install_path' "$CONFIG_FILE")
PORT=$(jq -r '.options.http_port' "$CONFIG_FILE")

echo "Setting up app..."
mkdir -p "$APP_DATA_PATH/data"
mkdir -p "$APP_DATA_PATH/logs"

# Generate secrets if not exists
if [[ ! -f "$APP_DATA_PATH/secrets.env" ]]; then
    cat > "$APP_DATA_PATH/secrets.env" <<EOF
SECRET_KEY=$(openssl rand -hex 32)
EOF
fi

echo "Setup complete"
exit 0
```

### system-update
**When it runs:** During app update, before containers are recreated

**Purpose:** Pre-update operations:
- Draining connections
- Creating pre-update snapshots
- Validating update prerequisites

### system-repair
**When it runs:** Automatically when health check fails N consecutive times (default: 3)

**Purpose:** Fix common issues:
- Restarting stuck containers
- Clearing caches
- Resetting network connections

### system-backup
**When it runs:** Before updates (if `backup_before_update: true`) and scheduled backups

**Purpose:** Create application-specific backups:
- Dump databases
- Package custom data
- Verify backup integrity

**Output:** Script should output JSON with backup info:
```bash
#!/bin/bash
# ...
jq -n \
    --arg file "$BACKUP_FILE" \
    --arg size "$BACKUP_SIZE" \
    --arg timestamp "$TIMESTAMP" \
    '{"backup_id": "backup-" + $timestamp, "file": $file, "size": $size}'
```

### system-restore
**When it runs:** When restoring from backup

**Purpose:** Restore app state:
- Import databases
- Restore configuration
- Validate restored data

## Action Scripts

Action scripts are exposed in the UI as buttons. They can have configurable options.

### Defining Options

Create an `.opts` file alongside the script:

```yaml
# scripts/create-backup.opts
name: create-backup
label: "Create Backup"
description: "Create a compressed backup of all app data"
icon: archive

confirm:
  enabled: true
  message: "This will create a backup of all app data. Continue?"

options:
  - name: include_logs
    type: boolean
    label: "Include Logs"
    description: "Include log files in backup"
    default: true

  - name: compression_level
    type: select
    label: "Compression"
    description: "Compression level"
    default: "standard"
    options:
      - value: "fast"
        label: "Fast (less compression)"
      - value: "standard"
        label: "Standard"
      - value: "maximum"
        label: "Maximum (slow)"

execution:
  timeout: 600
  stream_output: true
  user: root

output:
  format: json
  schema:
    type: object
    properties:
      backup_file:
        type: string
      size:
        type: string
```

### Option Types

| Type | YAML Type | Description |
|------|-----------|-------------|
| string | `string` | Text input |
| number | `number` | Numeric input |
| boolean | `boolean` | Checkbox |
| select | `select` | Dropdown |
| password | `password` | Secret input (not logged) |
| port | `port` | Port number validation |

## Config File Format

Scripts receive a JSON config file as the first argument:

```json
{
  "instance_id": "abc123",
  "app_id": "convertx",
  "install_path": "/var/lib/libreserv/apps/abc123",
  "app_data_path": "/var/lib/libreserv/apps/abc123/data",
  "config_path": "/var/lib/libreserv/apps/abc123/config.json",
  "runtime": {
    "compose_file": "/var/lib/libreserv/apps/abc123/app-compose/docker-compose.yml",
    "project_name": "libreserv-abc123"
  },
  "options": {
    "http_port": 3000,
    "http_allowed": "http://localhost:*",
    "account_registration": true
  },
  "secrets": {}
}
```

## Script Best Practices

1. **Error Handling**: Always use `set -euo pipefail` for bash scripts
2. **Logging**: Print progress to stdout/stderr (captured in logs)
3. **Output**: Use JSON output for structured data, stdout for text output
4. **Timeout**: Scripts have a default 300s timeout (configurable in `.opts`)
5. **Idempotency**: Scripts should be safe to run multiple times
6. **Permissions**: Scripts run as root by default (configurable in `.opts`)

## API Endpoints

### List Available Actions
```
GET /api/v1/apps/{instanceId}/actions
```

### Get Action Details
```
GET /api/v1/apps/{instanceId}/actions/{actionName}
```

### Execute Action
```
POST /api/v1/apps/{instanceId}/actions/{actionName}/execute
{
  "options": {
    "include_logs": true
  }
}
```

### Stream Action Output
```
GET /api/v1/apps/{instanceId}/actions/{actionName}/stream
```

## Example: Logs Viewer Action

```bash
#!/bin/bash
# scripts/view-logs

set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required"
    exit 1
fi

LINES=$(jq -r '.options.lines // 50' "$CONFIG_FILE")
FILTER=$(jq -r '.options.filter // ""' "$CONFIG_FILE")
APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")

if [[ -n "$FILTER" ]]; then
    tail -n "$LINES" "$APP_DATA_PATH/logs/app.log" | grep "$FILTER"
else
    tail -n "$LINES" "$APP_DATA_PATH/logs/app.log"
fi
```

```yaml
# scripts/view-logs.opts
name: view-logs
label: "View Logs"
description: "View application logs"

options:
  - name: lines
    type: number
    label: "Number of lines"
    default: 50
    min: 10
    max: 1000

  - name: filter
    type: string
    label: "Filter pattern"
    description: "Regex pattern to filter logs"
    required: false

execution:
  timeout: 60
  stream_output: true
```
