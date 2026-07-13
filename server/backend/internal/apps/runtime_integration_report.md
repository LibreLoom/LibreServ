# Runtime Integration Report: Compose → Podman Containers

## 1. File Inventory

| File | Package | Role |
|------|---------|------|
| server/backend/internal/podman/compose.go | podman | ComposeManager — executes podman compose CLI commands |
| server/backend/internal/podman/containers.go | podman | Client — direct container operations via podman CLI (ps, inspect, logs, stop, start, restart, stats) |
| server/backend/internal/podman/client.go | podman | Client factory — connection setup (socket/TCP/SSH), delegates compose ops to ComposeManager |
| server/backend/internal/podman/adapter.go | podman | RuntimeAdapter — implements runtime.ContainerRuntime interface |
| server/backend/internal/apps/manifest.go | apps | Manifest/ManifestVersion — loaded from manifest.yaml |
| server/backend/internal/apps/installer.go | apps | Installer.Install() — renders compose templates, computes SHA |
| server/backend/internal/apps/manager.go | apps | Manager.UpdateApp() — SHA gating for updates |
| server/backend/internal/runtime/interface.go | runtime | ContainerRuntime interface definition |

## 2. Compose → Container Flow

### 2.1 Template Rendering (Installer.Install)

1. Installer.Install() reads the app catalog definition and merges user config
2. processComposeTemplate(appDef, installPath, config) reads the source .yml.tmpl from the catalog, applies Go text/template with a fixed funcMap (generatePassword, dataPath, configPath, default, serverURL, serverDomain, smtpHost/Port/User/Pass/From)
3. Writes the rendered docker-compose.yml at installPath/docker-compose.yml (0600 perms)
4. Computes SHA-256 of the rendered compose via ComposeTemplateSHA(composePath) — stored in DB and in config["_compose_template_sha"]
5. Pins the image digest via ComposePinImageDigest() if the manifest has a LatestApproved() digest
6. Pre-creates bind mount volume directories via CreateVolumeDirs() (0750 perms)
7. Saves InstalledApp record to DB
8. Spawns async goroutine completeInstall():
   - runtime.ComposePull(ctx, composePath) — pulls images
   - runtime.ComposeUp(ctx, composePath) — starts containers with -d --remove-orphans
   - waitForContainers(instanceID) — polls until running

### 2.2 Runtime Adapter Chain

RuntimeAdapter.ComposeUp(ctx, path) -> Client.ComposeUp(ctx, composePath) -> ComposeManager.Up(ctx, composePath). ComposeManager.Up pre-creates volume dirs, resolves the compose path (file vs directory), then executes exec.CommandContext(ctx, "podman", "compose", "-f", absFile, "up", "-d", "--remove-orphans") with cmd.Dir = workDir.

All compose operations follow this same chain: RuntimeAdapter -> Client -> ComposeManager -> exec.CommandContext. Direct container ops (StopContainer, StartContainer, RestartContainer, GetContainerStats, InspectContainer, ContainerLogs) run bare podman subcommands in containers.go.

## 3. SHA Gating & Update Flow

### 3.1 SHA Storage (two locations)

- Database: apps.compose_template_sha column
- In-memory: app.Config["_compose_template_sha"]

### 3.2 Update Detection (GetAvailableUpdates, manager.go:1139-1142)

Checks if latest.ComposeTemplateSHA != "" && app.ComposeTemplateSHA != latest.ComposeTemplateSHA (composeTemplateChanged). Also checks digest: if currentDigest != "" && currentDigest != latestDigest, marks isUpdate = true.

### 3.3 Update Execution (UpdateApp, manager.go:688-956)

1. Lock via m.updateMu.Lock() to prevent concurrent updates on the same instance
2. Load catalog app and manifest via m.GetCatalog().GetApp() + LoadManifest(catalogApp.CatalogPath)
3. Select target version via manifest.LatestApproved() (approved with latest ApprovedAt)
4. Backup if catalogApp.Updates.BackupBeforeUpdate is true
5. Check SHA change — if app.ComposeTemplateSHA != targetVersion.ComposeTemplateSHA, mark changed
6. If SHA changed: re-render template with processComposeTemplate() (fills missing config fields with defaults, injects server context fields: server_port, server_mode, server_host, server_url, default_domain, caddy_mode, acme_email, smtp_*, tunnel_*, dns_provider), computes new SHA
7. Pin image digest via ComposePinImageDigest(composePath, catalogApp.Deployment.Image, targetVersion.Digest)
8. Run system-update script if scriptExecutor.GetSystemScriptPath(catalogApp.CatalogPath, "update") returns a path
9. Pull images via runtime.ComposePull(ctx, composePath)
10. Recreate containers via runtime.ComposeUp(ctx, composePath) (uses --remove-orphans to clean up old containers)
11. Health check via waitForHealthy(ctx, instanceID, 60*time.Second) — polls every 2s
12. On failure at step 10 or 11: rollback via backupService.RestoreApp() (stop -> restore -> restart), record failure
13. Persist: update image_digest, compose_template_sha columns, update metadata (config JSON), set StatusRunning

### 3.4 Manifest Versioning

Each version has: tag, digest, compose_template_sha, status (approved | revoked), approved_at, revoked_at (nullable), revocation_reason, severity, needs_config (boolean), needs_config_reason. LatestApproved() iterates versions and returns the one with status == "approved" and latest ApprovedAt. IsRevoked(tag) checks if a specific version has status == "revoked". NeedsConfig signals the app needs new config fields before update, surfaced in AvailableUpdate.

## 4. Runtime Operations Consuming Rendered Compose

| Operation | File | Method | CLI Command | Notes |
|-----------|------|--------|-------------|-------|
| Up | compose.go | ComposeManager.Up() | podman compose -f X up -d --remove-orphans | Pre-creates volume dirs |
| Down | compose.go | ComposeManager.Down() | podman compose -f X down | |
| Pull | compose.go | ComposeManager.Pull() | podman compose -f X pull | |
| Stop | compose.go | ComposeManager.Stop() | podman compose -f X stop --timeout 2 | Fallback: down --timeout 0 (3s context) |
| Up (safe) | compose.go | RunCustomAppSafely() | Same as Up, after hardening | Writes hardened compose in-place |
| Chown bind mounts | compose.go | ChownBindMounts() | podman run --rm -v X:/cleanup alpine chown -R uid:gid /cleanup | Per-mount via Alpine container |
| Chown directory | compose.go | ChownDir() | podman run --rm -v X:/cleanup alpine chown -R uid:gid /cleanup | For non-compose cleanup |
| Image digest pin | compose.go | ComposePinImageDigest() | In-place YAML edit | Replaces tag with @sha256:digest per service |
| Cleanup data dir | compose.go | CleanupAppDataDir() | Walks dirs, chowns compose bind mounts, removes dir | Used for dev reset |
| Container stop | containers.go | StopContainer() | podman stop <id> | Direct container operation |
| Container start | containers.go | StartContainer() | podman start <id> | |
| Container restart | containers.go | RestartContainer() | podman restart -t <secs> <id> | |
| List containers | containers.go | ListContainersByLabel() | podman ps -a --filter label=X --format json | |
| List all | containers.go | ListContainersAll() | podman ps -a --format json | |
| Stats | containers.go | GetContainerStats() | podman stats --no-stream --format json <id> | |
| Inspect | containers.go | InspectContainer() | podman inspect <id> | |
| Logs | containers.go | ContainerLogs() | podman logs <id> [--follow] [--tail N] | Combines stdout+stderr via io.Pipe |

## 5. Compose Validation & Safety Checks

### 5.1 Pre-Run Safety

1. Volume directory pre-creation (CreateVolumeDirs): parses compose YAML, extracts absolute bind mount host paths (must start with /), creates with 0750 perms before podman compose up. Prevents root-owned directories in bind mounts.
2. Graceful stop fallback (ComposeManager.Stop): tries podman compose stop --timeout 2 first; on failure, tries podman compose down --timeout 0 with a 3-second context. Both must fail for an error.
3. CLI error detection (composeError): detects "Cannot connect to the Docker/Podman daemon", "permission denied", and "unknown command compose" — returns user-friendly wrappers.

### 5.2 Security Hardening (RunCustomAppSafely)

For custom/hand-written app installations:
- cap_drop: [ALL] on every service
- read_only: true on every service
- security_opt: [no-new-privileges:true] appended (may duplicate if already present)
- user: uid:gid set to current host user (os.Getuid():os.Getgid())
- Writes hardened YAML in-place (0640) then calls Up()
- Edge case: cap_drop is replaced not merged with existing values

### 5.3 Fuzz Testing

compose_fuzz_test.go — FuzzComposeUnmarshal seeds valid compose files and fuzz-tests the same yaml.Unmarshal used in RunCustomAppSafely to guard against yaml.v3 panics on hash-of-unhashable-type inputs.

### 5.4 What's Missing

1. No YAML schema validation — rendered compose is passed directly to podman compose with no pre-validation.
2. No SHA verification against manifest — the manifest ComposeTemplateSHA is an identifier/cache key, not a verification token. No check ensures the rendered output matches the manifest's expected SHA.
3. No rollback on ComposePinImageDigest failure — non-fatal (logged as warning). Edits compose file in-place, so partial failure can leave the file malformed.
4. Template rendering is safe — fixed funcMap means user config values only appear as template data, not code. No injection vector.

## 6. Container Discovery

FindContainersByInstanceID (adapter.go:71-85) uses four label/namespace strategies:
1. libreserv.app label == instanceID
2. com.docker.compose.project label == instanceID
3. com.docker.compose.project label == libreserv-{instanceID}
4. Container name starts with {instanceID}- or {instanceID}_

Handles both bare containers and compose-managed containers.

## 7. Key Invariants & Edge Cases

1. ComposeManager is created fresh per call — Client.ComposeUp() calls NewComposeManager(c) each time. No shared state.
2. Binary is globally configured — setDefaultBinary(binary) sets a package-level variable; all exec.CommandContext calls use it (default: "podman").
3. SHA comparison is string-exact — no normalization or case-folding.
4. Template SHA is post-render — computed on rendered docker-compose.yml, not the source template. Different configs produce different SHAs for the same template.
5. No compose syntax validation — invalid templates surface as CLI errors during compose up, not during install.
6. ComposePinImageDigest is non-fatal during install — error logged as warning; can leave un-pinned image.
7. Update rollback is backup-gated — only works if BackupBeforeUpdate is true on the catalog app definition.
8. matchesInstance handles compose name prefixing — both - and _ delimiters are checked, covering compose's naming conventions.
