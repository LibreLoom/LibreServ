# App Template System

This document explains how LibreServ's app template system works internally — how app definitions are loaded, how Docker Compose templates are processed, and how the installation lifecycle is orchestrated.

For the file format specification of custom app packages, see [APP_PACKAGE_FORMAT.md](APP_PACKAGE_FORMAT.md).

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Catalog](#catalog)
- [App Definition Structure](#app-definition-structure)
- [Installation Lifecycle](#installation-lifecycle)
- [Docker Compose Templating](#docker-compose-templating)
- [Configuration Merging](#configuration-merging)
- [Port Management](#port-management)
- [Exposed Info](#exposed-info)
- [Update Flow](#update-flow)
- [Script Execution](#script-execution)
- [Health Checks](#health-checks)
- [Key Files](#key-files)

---

## Overview

LibreServ uses a **filesystem-based catalog** to define app templates. Each template is an `AppDefinition` loaded from a YAML manifest (`app.yaml`) bundled with a Docker Compose file, optional scripts, and an icon. Templates are never stored in the database — only installed app instances are.

There are two sources of templates:

| Type | Source | Description |
|------|--------|-------------|
| **builtin** | `server/backend/apps/builtin/` | Shipped with LibreServ |
| **custom** | Uploaded `.tar.xz` archives | User-provided packages |

---

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  app.yaml    │     │   Catalog    │     │    Installer     │
│  (on disk)   │────▶│  (in memory) │────▶│  (template → app)│
└──────────────┘     └──────────────┘     └──────────────────┘
                                                  │
                                                  ▼
                                          ┌──────────────────┐
                                          │  Installed App   │
                                          │  (DB + on disk)  │
                                          └──────────────────┘
```

1. **Catalog** loads and validates all `app.yaml` files at startup
2. **Installer** reads a definition from the catalog, processes the Compose template, and deploys containers
3. **Manager** handles the lifecycle of installed instances (start/stop/update/uninstall)

---

## Catalog

The `Catalog` struct (`internal/apps/catalog.go`) manages the in-memory registry of available app definitions.

### Loading

At startup, `Catalog.Load()` scans `{catalogPath}/builtin/` for subdirectories. Each subdirectory must contain an `app.yaml`. The file is unmarshaled into an `AppDefinition`, validated, and indexed by ID.

```go
// Config: apps.catalog_path = "./apps"
catalog := apps.NewCatalog("./apps")
catalog.Load() // scans ./apps/builtin/*/
```

### API

| Method | Description |
|--------|-------------|
| `GetApp(id)` | Returns a deep-cloned `AppDefinition` |
| `ListApps(filter)` | Returns filtered/paginated list |
| `GetCategories()` | Returns distinct category list |
| `Refresh()` | Re-scans the filesystem for changes |

The catalog returns **deep-cloned** objects to prevent callers from mutating the in-memory registry.

### Frontend Integration

- `useCatalog()` hook fetches from `GET /api/v1/catalog`
- `useCatalogApp(id)` hook fetches from `GET /api/v1/catalog/{id}`
- Icon served from `GET /api/v1/catalog/{id}/icon`

---

## App Definition Structure

The `AppDefinition` type (`internal/apps/types.go`) is the central data structure:

```go
type AppDefinition struct {
    // Identity
    ID, Name, Description, Version string
    Category    AppCategory
    Icon, Website, Repository string
    Featured    bool

    // How to run it
    Deployment    DeploymentConfig    // Compose file, ports, volumes, GPU
    Configuration []ConfigField       // User-facing settings
    ExposedInfo   []ExposedInfoField  // Post-install display fields
    HealthCheck   HealthCheckConfig
    Requirements  ResourceRequirements
    Updates       UpdateConfig
    Scripts       ScriptConfig
    Features      AppFeatures

    // Runtime (set by catalog loader, not from YAML)
    Type        AppType   // "builtin", "custom", "external"
    CatalogPath string    // Absolute path to this app's directory
}
```

See [APP_PACKAGE_FORMAT.md](APP_PACKAGE_FORMAT.md) for the full YAML schema.

---

## Installation Lifecycle

```
POST /api/v1/apps  {app_id, config: {...}}
    │
    ▼
Installer.Install()
    │
    ├─ 1. GetApp(appID) from catalog
    ├─ 2. Generate instanceID (16 hex chars, random)
    ├─ 3. Create install dir: {dataPath}/{instanceID}/
    ├─ 4. mergeConfig() — combine defaults + user values + auto-generated
    ├─ 5. generateAutoValues() — generate passwords for password-type fields
    ├─ 6. PortManager.Allocate() — find available ports for port-type fields
    ├─ 7. processComposeTemplate()
    │      ├─ Read {CatalogPath}/app-compose/docker-compose.yml
    │      ├─ Execute as Go text/template with merged config
    │      └─ Write to {installPath}/docker-compose.yml
    ├─ 8. createMetadataFile() — write .libreserv.yaml
    ├─ 9. createDataDirectories() — data/, config/, logs/
    ├─ 10. copyScripts() — copy scripts/ from catalog to install dir
    ├─ 11. saveInstalledApp() — INSERT INTO apps
    │
    └─ 12. (async) completeInstall()
           ├─ docker compose pull
           ├─ docker compose up -d
           ├─ Wait for containers running
           ├─ Register health checks
           ├─ Run system-setup script (if present)
           └─ Merge script exposed_info output
```

Each installed instance gets a unique `instanceID` (16-character hex string) that serves as the primary identifier for all operations.

---

## Docker Compose Templating

Compose files are Go `text/template` templates processed at install time. The template engine provides these values and functions:

### Available Variables

| Variable | Source | Example |
|----------|--------|---------|
| `{{.instance_id}}` | Auto-generated | `a1b2c3d4e5f6...` |
| `{{.app_name}}` | User input | `My Ollama` |
| `{{.install_path}}` | Computed | `/var/lib/libreserv/apps/a1b2c3...` |
| `{{.dataPath}}` | Computed | `/var/lib/libreserv/apps/a1b2c3.../data` |
| `{{.configPath}}` | Computed | `/var/lib/libreserv/apps/a1b2c3.../config` |
| `{{.field_name}}` | Config field value | `11434`, `true`, `mypassword` |

### Helper Functions

| Function | Usage | Description |
|----------|-------|-------------|
| `{{ dataPath }}` | As function | Resolves to install path + `/data` |
| `{{ configPath }}` | As function | Resolves to install path + `/config` |
| `{{ generatePassword N }}` | `{{ generatePassword 24 }}` | Generate N-char secure random password |
| `{{ default "fallback" .var }}` | Conditional | Use fallback if `.var` is empty |

### Conditional Blocks

Standard Go template conditionals work:

```yaml
{{- if .enable_gpu }}
    runtime: nvidia
{{- end }}
```

### Example

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    container_name: "{{.instance_id}}-ollama"
    ports:
      - "{{.api_port}}:11434"
{{- if .enable_gpu }}
    runtime: nvidia
{{- end }}
    volumes:
      - "{{ dataPath }}/ollama:/root/.ollama"
    environment:
      - "OLLAMA_HOST={{.host}}:11434"
```

The processed output is written to `{installPath}/docker-compose.yml`.

---

## Configuration Merging

Configuration values are merged in this order (later overrides earlier):

1. **Field defaults** — `default` values from `app.yaml` configuration fields
2. **Deployment environment** — `environment` map from the deployment config
3. **User input** — values provided by the user during install wizard
4. **Auto-generated** — passwords for fields with `type: password` (if not provided by user)

Port-type fields get auto-allocated by the `PortManager` starting from the field's default value.

---

## Port Management

The `PortManager` (`internal/apps/port_manager.go`) tracks host port usage:

- **Startup**: Scans all installed apps' metadata for allocated ports
- **Install**: Allocates by scanning upward from the field's default port until an available one is found
- **Verification**: Checks both internal tracking and OS-level binding
- **Uninstall**: Releases allocated ports back to the pool

---

## Exposed Info

Apps can surface credentials and connection details to the user via `exposed_info` fields in `app.yaml`:

```yaml
exposed_info:
  - name: admin_password
    label: "Admin Password"
    type: password
    copyable: true
    revealable: true
    mask_by_default: true
    group: credentials
```

Values come from two sources:
1. **Config map** — for fields defined in `configuration`
2. **Script output** — `system-setup` and other scripts can return JSON with `exposed_info` that gets merged at runtime

The frontend `ExposedInfoCard` component renders these with reveal/copy/mask interactions.

---

## Update Flow

```
Manager.UpdateApp(instanceID)
    │
    ├─ Get current version from installed config
    ├─ Get latest version from catalog definition
    ├─ If backup_before_update: run system-backup script
    ├─ Run system-update script (if present)
    ├─ docker compose pull && docker compose up -d
    ├─ Wait for health check to pass
    └─ If unhealthy after update: rollback from backup
```

Update strategies defined in `app.yaml`:
- **manual** — admin must trigger
- **notify** — admin is notified, must approve
- **auto** — updates applied automatically

---

## Script Execution

Scripts live in `scripts/` within the app package directory and are copied to the install directory during installation.

### System Scripts

| Script | Trigger | Purpose |
|--------|---------|---------|
| `system-setup` | After first container start | One-time initialization |
| `system-update` | Before update | Pre-update operations |
| `system-repair` | Health check failure | Automated recovery |
| `system-backup` | Before updates / scheduled | Create backup snapshot |
| `system-restore` | Restore operation | Restore from backup |

### Script Input

All scripts receive a JSON config file as their first argument:

```json
{
  "instance_id": "a1b2c3d4...",
  "install_path": "/var/lib/libreserv/apps/a1b2c3...",
  "app_data_path": "/var/lib/libreserv/apps/a1b2c3.../data",
  "config_path": "/var/lib/libreserv/apps/a1b2c3.../config",
  "runtime": {
    "compose_file": "docker-compose.yml",
    "project_name": "libreserv-a1b2c3"
  },
  "options": {}
}
```

### Script Output

Scripts can output JSON to stdout to communicate results:

```json
{
  "exposed_info": {
    "initial_password": "generated-password-here"
  }
}
```

### Security

Script paths are validated against allowed directories (install path or catalog path). Path traversal is rejected.

---

## Health Checks

Configured per-app in `app.yaml`:

| Type | Method |
|------|--------|
| `http` | HTTP GET to `endpoint` on app port |
| `tcp` | TCP connection to port |
| `container` | Docker's built-in HEALTHCHECK |
| `command` | Shell command execution |

Checks run at the configured `interval` (default 30s). After `retries` consecutive failures, the app is marked unhealthy and `system-repair` is attempted.

---

## Key Files

| File | Role |
|------|------|
| `server/backend/internal/apps/types.go` | All type definitions |
| `server/backend/internal/apps/catalog.go` | Catalog loading and indexing |
| `server/backend/internal/apps/installer.go` | Template processing and installation |
| `server/backend/internal/apps/manager.go` | App lifecycle orchestration |
| `server/backend/internal/apps/port_manager.go` | Host port allocation |
| `server/backend/internal/apps/script_executor.go` | Script execution |
| `server/backend/internal/api/handlers/catalog.go` | Catalog REST endpoints |
| `server/backend/internal/api/handlers/apps.go` | App management REST endpoints |
| `server/backend/apps/builtin/` | Built-in app template directories |
| `server/frontend/src/hooks/useCatalog.jsx` | Frontend catalog data fetching |
| `server/frontend/src/components/app/wizard/InstallWizard.jsx` | Installation wizard UI |
