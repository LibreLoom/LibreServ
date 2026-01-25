# Script Development Guide

This guide provides comprehensive documentation for creating scripts that extend LibreServ application functionality. Scripts enable custom lifecycle operations, automated maintenance tasks, and user-facing actions exposed through the LibreServ UI.

## Table of Contents

- [Script System Overview](#script-system-overview)
  - [Script Types](#script-types)
  - [Folder Structure](#folder-structure)
- [System Scripts](#system-scripts)
  - [system-setup](#system-setup)
  - [system-update](#system-update)
  - [system-repair](#system-repair)
  - [system-backup](#system-backup)
  - [system-restore](#system-restore)
- [Action Scripts](#action-scripts)
  - [Creating Action Scripts](#creating-action-scripts)
  - [Defining Options](#defining-options)
  - [Option Types Reference](#option-types-reference)
- [Configuration File Format](#configuration-file-format)
- [Script Best Practices](#script-best-practices)
- [API Reference](#api-reference)
- [Complete Examples](#complete-examples)
  - [Complete System Script Example](#complete-system-script-example)
  - [Complete Action Script with Options](#complete-action-script-with-options)

---

## Script System Overview

LibreServ's script system provides a powerful mechanism for extending application functionality beyond the standard Docker Compose deployment model. Scripts are executable programs (typically shell scripts) that run at specific points in an application's lifecycle or are exposed as user-facing actions.

### Script Types

| Type | Prefix | Purpose | Execution Context |
|------|--------|---------|-------------------|
| System Scripts | `system-*` | Automated lifecycle operations | Root user, automatic execution |
| Action Scripts | `action-*` | User-facing operations | Configurable user, on-demand |

**System Scripts** run automatically during specific lifecycle events:
- **Setup**: One-time initialization when app is first installed
- **Update**: Pre-update operations before container replacement
- **Repair**: Automated recovery when health checks fail
- **Backup**: Custom backup creation for app data
- **Restore**: Data restoration from backups

**Action Scripts** are exposed in the LibreServ UI as buttons that users can click to perform operations:
- View logs
- Create backups
- Configure settings
- Execute maintenance tasks
- Any custom operation

### Folder Structure

Scripts reside in the `scripts/` directory within the app package:

```
app-name/
├── app.yaml                              # App metadata (required)
├── app-compose/                          # Docker environment
│   └── docker-compose.yml
└── scripts/                              # Scripts directory (optional)
    ├── system-setup                      # Initial setup (first install only)
    ├── system-update                     # Update app version
    ├── system-repair                     # Auto-repair on health failure
    ├── system-backup                     # Create backup
    ├── system-restore                    # Restore from backup
    ├── action-logs                       # User-facing: View Logs
    ├── action-logs.opts                  # Action configuration
    ├── action-backup                     # User-facing: Create Backup
    └── action-backup.opts                # Action configuration
```

---

## System Scripts

### system-setup

**Purpose:** One-time initialization tasks that run after the app container is confirmed fully started for the first time.

**When It Runs:** Once, after initial container startup, only on first installation.

**Use Cases:**
- Creating required directories
- Generating initial secrets
- Setting up database schemas
- Downloading initial data
- Configuring default settings
- Running database migrations

**Execution Environment:**
- User: Root
- Working Directory: App install directory
- Timeout: 300 seconds (configurable)
- Output: stdout/stderr captured to logs

**Example:**

```bash
#!/bin/bash
set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required"
    exit 1
fi

APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")
INSTALL_PATH=$(jq -r '.install_path' "$CONFIG_FILE")
PORT=$(jq -r '.options.http_port' "$CONFIG_FILE")

echo "Setting up app..."
mkdir -p "$APP_DATA_PATH/data"
mkdir -p "$APP_DATA_PATH/logs"

if [[ ! -f "$APP_DATA_PATH/secrets.env" ]]; then
    cat > "$APP_DATA_PATH/secrets.env" <<EOF
SECRET_KEY=$(openssl rand -hex 32)
DATABASE_PASSWORD=$(openssl rand -base64 24)
EOF
fi

echo "Setup complete"
exit 0
```

---

### system-update

**Purpose:** Pre-update operations that run before containers are recreated during an app update.

**When It Runs:** During app update, before stopping the current container.

**Use Cases:**
- Draining active connections gracefully
- Creating pre-update data snapshots
- Validating update prerequisites
- Backing up user-generated content
- Exporting configuration
- Cleaning up temporary files

**Execution Environment:**
- User: Root
- Working Directory: App install directory
- Timeout: 300 seconds (configurable)
- Output: stdout/stderr captured to logs

**Important:** This script runs BEFORE the new container starts. Any changes here persist to the update.

**Example:**

```bash
#!/bin/bash
set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required"
    exit 1
fi

APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")
echo "Starting update preparation for $APP_DATA_PATH"

# Signal app to stop accepting new connections
echo "Draining connections..."
# Add your app-specific drain logic here

# Create pre-update snapshot
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$APP_DATA_PATH/pre-update-$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

# Copy critical data
cp -r "$APP_DATA_PATH/data" "$BACKUP_DIR/" 2>/dev/null || true
cp -r "$APP_DATA_PATH/config" "$BACKUP_DIR/" 2>/dev/null || true

echo "Pre-update snapshot created at $BACKUP_DIR"
echo "Update preparation complete"
exit 0
```

---

### system-repair

**Purpose:** Automated recovery operations triggered when health checks fail N consecutive times.

**When It Runs:** Automatically when health check fails N consecutive times (default: 3).

**Use Cases:**
- Restarting stuck containers
- Clearing corrupted caches
- Resetting network connections
- Recovering from temporary failures
- Recycling transient resources
- Reinitializing failed services

**Execution Environment:**
- User: Root
- Working Directory: App install directory
- Timeout: 300 seconds (configurable)
- Output: stdout/stderr captured to logs

**Important:** This script is called automatically by LibreServ's health monitoring system. Design recovery logic to be safe to run multiple times.

**Example:**

```bash
#!/bin/bash
set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required"
    exit 1
fi

INSTANCE_ID=$(jq -r '.instance_id' "$CONFIG_FILE")
APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")

echo "Running repair for instance $INSTANCE_ID"

# Clear caches
echo "Clearing caches..."
rm -rf "$APP_DATA_PATH/cache/"* 2>/dev/null || true

# Restart container gracefully
echo "Restarting application container..."
# docker restart is handled by LibreServ, just prepare the environment

# Verify essential files exist
if [[ ! -f "$APP_DATA_PATH/config/app.conf" ]]; then
    echo "Regenerating default configuration..."
    cat > "$APP_DATA_PATH/config/app.conf" <<EOF
app_mode=production
log_level=info
EOF
fi

echo "Repair operations complete"
exit 0
```

---

### system-backup

**Purpose:** Create application-specific backups for data preservation.

**When It Runs:**
- Before updates (if `backup_before_update: true` is set)
- During scheduled backups
- When triggered manually via action

**Use Cases:**
- Dumping databases
- Packaging custom data
- Archiving user content
- Verifying backup integrity
- Encrypting sensitive data
- Uploading to external storage

**Output Format:** Scripts must output JSON with backup metadata to stdout:

```bash
#!/bin/bash
# ...
jq -n \
    --arg file "$BACKUP_FILE" \
    --arg size "$BACKUP_SIZE" \
    --arg timestamp "$TIMESTAMP" \
    '{"backup_id": "backup-" + $timestamp, "file": $file, "size": $size}'
```

**Output Schema:**

| Field | Type | Description |
|-------|------|-------------|
| `backup_id` | string | Unique backup identifier |
| `file` | string | Path to backup archive |
| `size` | string | Human-readable size |
| `timestamp` | string | ISO 8601 timestamp |
| `checksum` | string | SHA256 checksum (optional) |

**Example:**

```bash
#!/bin/bash
set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required"
    exit 1
fi

APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$APP_DATA_PATH/backups/backup-$TIMESTAMP.tar.gz"

echo "Starting backup..."
mkdir -p "$APP_DATA_PATH/backups"

# Create backup archive
tar -czf "$BACKUP_FILE" \
    -C "$APP_DATA_PATH" \
    data \
    config \
    logs 2>/dev/null || true

# Calculate size
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

# Output metadata as JSON
jq -n \
    --arg file "$BACKUP_FILE" \
    --arg size "$SIZE" \
    --arg timestamp "$TIMESTAMP" \
    '{
        backup_id: "backup-" + $timestamp,
        file: $file,
        size: $size,
        timestamp: $timestamp
    }'

echo "Backup complete: $BACKUP_FILE ($SIZE)"
exit 0
```

---

### system-restore

**Purpose:** Restore application state from a backup.

**When It Runs:** When restoring an app from a previous backup.

**Use Cases:**
- Importing database dumps
- Restoring configuration files
- Recovering user data
- Validating restored data
- Resetting permissions
- Restarting services after restore

**Execution Environment:**
- User: Root
- Working Directory: App install directory
- Timeout: 600 seconds (configurable)
- Output: stdout/stderr captured to logs

**Example:**

```bash
#!/bin/bash
set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required"
    exit 1
fi

BACKUP_FILE="${2:-}"
if [[ -z "$BACKUP_FILE" ]]; then
    echo "ERROR: Backup file path required"
    exit 1
fi

APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")

echo "Starting restore from $BACKUP_FILE"

# Verify backup exists
if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "ERROR: Backup file not found: $BACKUP_FILE"
    exit 1
fi

# Stop application
echo "Stopping application..."
# Application will be stopped by LibreServ before restore

# Clear existing data
echo "Clearing existing data..."
rm -rf "$APP_DATA_PATH/data/"* 2>/dev/null || true
rm -rf "$APP_DATA_PATH/config/"* 2>/dev/null || true

# Extract backup
echo "Extracting backup..."
tar -xzf "$BACKUP_FILE" -C "$APP_DATA_PATH"

# Verify restoration
if [[ -d "$APP_DATA_PATH/data" ]]; then
    echo "Restore verification: data directory exists"
else
    echo "WARNING: Restored backup may be incomplete"
fi

echo "Restore complete"
exit 0
```

---

## Action Scripts

### Creating Action Scripts

Action scripts are user-facing operations exposed in the LibreServ UI. Unlike system scripts, users can execute actions on demand with optional configurable parameters.

**Basic Structure:**

```bash
#!/bin/bash
set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required"
    exit 1
fi

# Parse configuration
LINES=$(jq -r '.options.lines // 50' "$CONFIG_FILE")
FILTER=$(jq -r '.options.filter // ""' "$CONFIG_FILE")
APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")

# Execute action
echo "Processing request with $LINES lines..."

if [[ -n "$FILTER" ]]; then
    tail -n "$LINES" "$APP_DATA_PATH/logs/app.log" | grep "$FILTER"
else
    tail -n "$LINES" "$APP_DATA_PATH/logs/app.log"
fi

exit 0
```

### Defining Options

Action options are defined in `.opts` files alongside the script. These files control UI presentation, input validation, and execution behavior.

**Complete Options Schema:**

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

  - name: retention_days
    type: number
    label: "Retention Days"
    description: "How long to keep this backup"
    default: 30
    min: 1
    max: 365

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

### Option Types Reference

| Type | YAML Type | UI Component | Description |
|------|-----------|--------------|-------------|
| `string` | `string` | Text input | Single-line text entry |
| `number` | `number` | Number input | Numeric value with optional min/max |
| `boolean` | `boolean` | Toggle switch | True/false selection |
| `select` | `select` | Dropdown | Single selection from options |
| `password` | `password` | Password input | Secret text (masked, not logged) |
| `port` | `port` | Port input | Port number validation (1-65535) |

**Option Schema Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Option identifier (used in script) |
| `label` | string | Yes | UI label |
| `type` | string | Yes | Option type |
| `description` | string | No | Help text |
| `default` | varies | No | Default value |
| `required` | boolean | No | Whether value is required |
| `min` | number | No | Minimum value (number/port) |
| `max` | number | No | Maximum value (number/port) |
| `options` | array | For select | Available options |

---

## Configuration File Format

All scripts receive a JSON configuration file as the first argument. This file contains all necessary context for the script to operate.

**Complete Config Schema:**

```json
{
  "instance_id": "abc123def456",
  "app_id": "convertx",
  "app_name": "My Application",
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

**Field Reference:**

| Field | Type | Description |
|-------|------|-------------|
| `instance_id` | string | Unique instance identifier |
| `app_id` | string | Application ID from app.yaml |
| `app_name` | string | User-provided app name |
| `install_path` | string | App installation directory |
| `app_data_path` | string | App data directory |
| `config_path` | string | Path to this config file |
| `runtime.compose_file` | string | Docker Compose file path |
| `runtime.project_name` | string | Docker Compose project name |
| `options` | object | User-configured options |
| `secrets` | object | Sensitive values (passwords, API keys) |

**Parsing Configuration:**

```bash
# Using jq (recommended)
APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")
PORT=$(jq -r '.options.http_port // 8080' "$CONFIG_FILE")
INSTANCE_ID=$(jq -r '.instance_id' "$CONFIG_FILE")

# Boolean values
ENABLE_FEATURE=$(jq -r '.options.enable_feature | tostring' "$CONFIG_FILE")

# Arrays
TAGS=$(jq -r '.options.tags | join(",")' "$CONFIG_FILE")
```

---

## Script Best Practices

### Error Handling

Always use strict error handling for shell scripts:

```bash
#!/bin/bash
set -euo pipefail

# The above enables:
# -e: Exit on error
# -u: Exit on undefined variable
# -o pipefail: Catch errors in pipelines
```

### Logging

Print progress to stdout/stderr. All output is captured and associated with the script execution:

```bash
echo "Starting backup process..."
echo "Backup file: $BACKUP_FILE" >&2  # Stderr for debug info
echo "ERROR: Failed to create backup" >&2  # Error messages
```

### Output Formats

| Purpose | Format | Usage |
|---------|--------|-------|
| Progress updates | Plain text | User-visible messages |
| Structured data | JSON | Return values, backup metadata |
| Error messages | Plain text | Stderr with error details |

### Idempotency

Design scripts to be safe to run multiple times:

```bash
# GOOD: Idempotent - safe to run multiple times
mkdir -p "$APP_DATA_PATH/data"

# BAD: Not idempotent - will fail on second run
echo "data" > "$APP_DATA_PATH/data/exists"
```

### Timeout Considerations

| Script Type | Default Timeout | Recommended Setting |
|-------------|-----------------|---------------------|
| system-setup | 300s | 300-600s for complex setup |
| system-update | 300s | 300s for quick operations |
| system-repair | 300s | 300s for recovery tasks |
| system-backup | 300s | 600s for large datasets |
| system-restore | 300s | 600s for large restores |
| Action scripts | 300s | Varies by operation |

### Permissions

Scripts run as root by default. Reduce privileges when possible:

```yaml
# In .opts file
execution:
  user: root  # or specific user like "appuser"
```

---

## API Reference

Scripts can be invoked programmatically through the LibreServ API.

### List Available Actions

```http
GET /api/v1/apps/{instanceId}/actions
```

**Response:**

```json
{
  "actions": [
    {
      "name": "logs",
      "label": "View Logs",
      "description": "View application logs"
    },
    {
      "name": "backup",
      "label": "Create Backup",
      "description": "Create a compressed backup"
    }
  ]
}
```

### Get Action Details

```http
GET /api/v1/apps/{instanceId}/actions/{actionName}
```

**Response:**

```json
{
  "name": "backup",
  "label": "Create Backup",
  "description": "Create a compressed backup of all app data",
  "options": [
    {
      "name": "include_logs",
      "type": "boolean",
      "label": "Include Logs",
      "default": true
    }
  ],
  "confirm": {
    "enabled": true,
    "message": "This will create a backup of all app data. Continue?"
  }
}
```

### Execute Action

```http
POST /api/v1/apps/{instanceId}/actions/{actionName}/execute
Content-Type: application/json

{
  "options": {
    "include_logs": true,
    "compression_level": "standard"
  }
}
```

**Response:**

```json
{
  "execution_id": "exec-abc123",
  "status": "running",
  "started_at": "2024-01-15T10:30:00Z"
}
```

### Stream Action Output

```http
GET /api/v1/apps/{instanceId}/actions/{actionName}/stream/{executionId}
```

Response is a Server-Sent Events (SSE) stream:

```
data: {"line": "Starting backup..."}
data: {"line": "Compressing files..."}
data: {"line": "Backup complete: backup-20240115.tar.gz (100MB)", "status": "success"}
```

---

## Complete Examples

### Complete System Script Example

```bash
#!/bin/bash
# scripts/system-setup
# One-time setup script for initializing the application

set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required" >&2
    exit 1
fi

echo "=== Starting application setup ==="

APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")
INSTALL_PATH=$(jq -r '.install_path' "$CONFIG_FILE")
INSTANCE_ID=$(jq -r '.instance_id' "$CONFIG_FILE")
PORT=$(jq -r '.options.http_port // 8080' "$CONFIG_FILE")
ADMIN_PASSWORD=$(jq -r '.secrets.admin_password // ""' "$CONFIG_FILE")

echo "Instance ID: $INSTANCE_ID"
echo "Data path: $APP_DATA_PATH"
echo "HTTP port: $PORT"

# Create required directories
echo "Creating directory structure..."
mkdir -p "$APP_DATA_PATH/data"
mkdir -p "$APP_DATA_PATH/logs"
mkdir -p "$APP_DATA_PATH/config"
mkdir -p "$APP_DATA_PATH/backups"

# Generate secrets if not already present
if [[ ! -f "$APP_DATA_PATH/secrets.env" ]]; then
    echo "Generating secrets..."
    cat > "$APP_DATA_PATH/secrets.env" <<EOF
SECRET_KEY=$(openssl rand -hex 32)
DATABASE_KEY=$(openssl rand -base64 24)
API_TOKEN=$(openssl rand -hex 16)
EOF
    chmod 600 "$APP_DATA_PATH/secrets.env"
else
    echo "Secrets file already exists, skipping generation"
fi

# Create default configuration
if [[ ! -f "$APP_DATA_PATH/config/app.conf" ]]; then
    echo "Creating default configuration..."
    cat > "$APP_DATA_PATH/config/app.conf" <<EOF
app_name=$INSTANCE_ID
listen_port=$PORT
log_level=info
data_directory=$APP_DATA_PATH/data
backup_directory=$APP_DATA_PATH/backups
EOF
fi

# Initialize database if needed
if [[ -f "$APP_DATA_PATH/data/db.sqlite" ]]; then
    echo "Database already exists"
else
    echo "Initializing database..."
    # Add database initialization commands here
    touch "$APP_DATA_PATH/data/db.sqlite"
fi

echo "=== Setup complete ==="
exit 0
```

### Complete Action Script with Options

**Action Script** (`scripts/view-logs`):

```bash
#!/bin/bash
# scripts/view-logs
# View application logs with filtering options

set -euo pipefail

CONFIG_FILE="${1:-}"
if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file path required" >&2
    exit 1
fi

LINES=$(jq -r '.options.lines // 50' "$CONFIG_FILE")
FILTER=$(jq -r '.options.filter // ""' "$CONFIG_FILE")
FOLLOW=$(jq -r '.options.follow // false' "$CONFIG_FILE")
APP_DATA_PATH=$(jq -r '.app_data_path' "$CONFIG_FILE")

LOG_FILE="$APP_DATA_PATH/logs/app.log"

if [[ ! -f "$LOG_FILE" ]]; then
    echo "ERROR: Log file not found: $LOG_FILE" >&2
    exit 1
fi

echo "=== Application Logs ==="
echo "File: $LOG_FILE"
echo "Lines: $LINES"
echo "Filter: ${FILTER:-none}"
echo "Follow: $FOLLOW"
echo "=== Begin Logs ==="

if [[ "$FOLLOW" == "true" ]]; then
    tail -n "$LINES" -f "$LOG_FILE" | grep --line-buffered "$FILTER" || true
else
    if [[ -n "$FILTER" ]]; then
        grep "$FILTER" "$LOG_FILE" | tail -n "$LINES"
    else
        tail -n "$LINES" "$LOG_FILE"
    fi
fi

echo "=== End Logs ==="
exit 0
```

**Options File** (`scripts/view-logs.opts`):

```yaml
name: view-logs
label: "View Logs"
description: "View and filter application logs"
icon: file-text

confirm:
  enabled: false

options:
  - name: lines
    type: number
    label: "Number of lines"
    description: "How many lines to display"
    default: 50
    min: 10
    max: 1000

  - name: filter
    type: string
    label: "Filter pattern"
    description: "Regex pattern to filter logs"
    required: false

  - name: follow
    type: boolean
    label: "Follow logs"
    description: "Stream logs in real-time"
    default: false

execution:
  timeout: 60
  stream_output: true
  user: root
```

**app.yaml Integration:**

```yaml
scripts:
  actions:
    - name: logs
      label: "View Logs"
      script: scripts/view-logs
      confirm: false
```
