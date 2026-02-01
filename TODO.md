# Backend Hardening TODO

**Last Updated**: 2025-01-31

## Summary

**Completion Status**: 🎉 **MAJOR MILESTONE ACHIEVED** - Core hardening completed!

- ✅ **10 of 11** major items completed
- ⏸️ **2 items** deferred (require architectural work or are lower priority)
- ✅ **Comprehensive test suite** added and passing
- ✅ **All critical security and stability improvements** implemented

**Key Achievements**:
- Pinned all Docker images to stable tags
- Hardened CORS defaults to prevent open access
- Fixed GPU support for Docker Compose (non-swarm)
- Implemented structured error handling
- Added 35 comprehensive test functions covering critical paths (18 network + 17 apps)
- Improved Caddy configuration reliability with retry/backoff logic
- Fixed deadlock in CaddyManager.UpdateDefaults
- ✅ **SAST Integration**: Added gosec and staticcheck to CI/CD pipeline (both working with Go 1.25)
- ✅ **Fixed 140 G104 errors**: All unhandled errors now properly handled
- ✅ **Fixed 1 real bug**: Ineffective break statement in script_executor.go
- ✅ **Docker API migration**: Updated from deprecated types.StatsJSON to container.StatsResponse

**Remaining Work**:
- Optional enhancements (metrics, audit logging, job persistence, fuzz testing)
- Documentation updates for new security scanning

---

## App Catalog Hardening

- ✅ **COMPLETED**: Pin images to stable tags and document update cadence.
  - SearXNG: `searxng/searxng:2024.12.18-b8443118c`
  - Redis: `redis:7.4-alpine`
  - Nextcloud AIO: `nextcloud/all-in-one:20241220_081520-latest`
  - Ollama: `ollama/ollama:0.5.4`
  - ConvertX: `ghcr.io/c4illin/convertx:0.5.2`

- ⏸️ **DEFERRED**: Avoid port collisions (dynamic assignment or reverse-proxy mapping).
  - Would require port allocation service; recommend using reverse proxy for production.

- ✅ **COMPLETED**: SearXNG base URL should be templated for reverse proxy; ensure health path is valid.
  - Added configurable `base_url` parameter
  - Defaults to localhost, can be set for reverse proxy deployments

- ✅ **COMPLETED**: Nextcloud AIO docker socket access.
  - Documented that `/var/run/docker.sock` bind is required for AppAPI functionality
  - Added security note explaining the requirement

- ✅ **COMPLETED**: Ollama GPU settings: ensure compose works without swarm; consider `runtime: nvidia`/device requests.
  - Changed from `deploy.resources.reservations` to `runtime: nvidia`
  - Added `NVIDIA_VISIBLE_DEVICES` environment variable
  - Now compatible with regular docker-compose (non-swarm)

- ✅ **COMPLETED**: Tighten CORS defaults (Ollama/ConvertX) from `*` unless explicitly set.
  - Ollama default: `http://localhost:*`
  - ConvertX default: `http://localhost:*`
  - Added documentation encouraging specific origins in production

- 🔄 **IN PROGRESS**: Project goals: add SSO/IdP integration and feature-matrix endpoints; cloud backup/relay/AI helper wiring.

- ✅ **COMPLETED**: Create the missing backend tests!
  - Added comprehensive network module tests (18 tests including existing)
  - Added comprehensive app catalog tests (17 tests including existing)
  - All 35 tests passing
  - Fixed deadlock issue in UpdateDefaults method

## Caddy/ACME Hardening Checklist

Goal: make Caddy reload + ACME issuance reliable, configurable, and observable.

### 1) ✅ **COMPLETED**: Config schema + defaults
   - ✅ All Caddy operational toggles already exist in config
   - ✅ Mode: `enabled/noop/disabled` (in `types.go`, `config.go`, `libreserv.yaml`)
   - ✅ Reload: retries, backoff_min/max, jitter, attempt_timeout configured
   - ✅ Logging: output (stdout|stderr|file), file path, format (console|json), level
   - ✅ ACME: External ACME config structure exists with DNS provider support
   - ✅ Admin API precedence and fallback implemented

### 2) ✅ **COMPLETED**: Reload hardening
   - ✅ Centralized reload strategy in `reloadCaddy()` with retries/backoff/jitter
   - ✅ Prefers Admin API `POST /load`, falls back to CLI `caddy reload`
   - ✅ Returns structured errors via `CaddyError` type
   - ✅ Idempotent/safe with clear file/read errors and request timeouts

### 3) ✅ **COMPLETED**: Configurable logging output
   - ✅ Logging templated (not hardcoded) in Caddyfile generation
   - ✅ Supports stdout/stderr/file output with directory creation
   - ✅ Optional JSON format support
   - ✅ Documented via config defaults in `libreserv.yaml`

### 4) ✅ **COMPLETED**: No-op/disabled mode when Caddy is missing
   - ✅ Disabled/noop execution paths in `caddy.go` and API handlers
   - ✅ Route CRUD operations succeed, reload operations return structured errors
   - ✅ `GetStatus` surfaces "disabled/noop" mode distinctly with clear messaging

### 5) ✅ **PARTIALLY COMPLETED**: Surface errors to callers
   - ✅ Route CRUD returns reload failure context with structured errors
   - ⏸️ **DEFERRED**: Fire-and-forget ACME issuance uses async goroutine; full job queue would require persistence layer
   - ✅ Implemented real `ConfigureDomain` and `GetDomainConfig` endpoints backed by Caddy config

### 6) ⏸️ **DEFERRED**: Real cert lifecycle (beyond reload)
   - ⏸️ External ACME client config exists but not fully integrated with issuance flow
   - ⏸️ DNS-01 support: provider config/env validation exists, needs integration
   - ⏸️ Lifecycle endpoints: Basic endpoints exist, would benefit from job tracking
   - Note: Current async issuance via goroutine is functional for basic use cases

### 7) ✅ **COMPLETED**: Tests
   - ✅ Comprehensive test suite added: `internal/network/caddy_test.go`
   - ✅ Mode configuration tests (enabled/noop/disabled)
   - ✅ Route CRUD operations
   - ✅ Domain availability checks
   - ✅ Caddyfile generation and validation
   - ✅ Status reporting in different modes
   - ✅ Error handling with structured error types
   - ✅ UpdateDefaults functionality
   - ✅ 18 network tests total (14 new + 4 existing), all passing

### 8) 📝 **TODO**: Docs/operator guidance
   - Document Admin API configuration
   - Document DNS-01 provider setup (providers/permissions)
   - Document log targets and production defaults
   - Document noop/disabled modes usage
   - Document domain config endpoints

### 9) ✅ **COMPLETED**: Nice-to-have follow-ups
   - ✅ Structured error types implemented:
     - `CaddyError` wrapper with operation context
     - `ErrCaddyDisabled`, `ErrAdminUnreachable`, `ErrReloadRejected`
     - `ErrConfigInvalid`, `ErrRouteNotFound`, `ErrRouteDuplicate`, `ErrBackendUnreachable`
   - ⏸️ **DEFERRED**: Metrics counters (reload attempts/failures, issuance failures)
   - ⏸️ **DEFERRED**: Audit log entries for issued/failed certs

---

## App Update System Improvements

**Current State**: Basic manual update via API (`docker compose pull + restart`). No automatic checking, notifications, or backup integration despite app configs declaring `strategy: notify` and `backup_before_update: true`.

### Short-term (High Priority)

1. ✅ **COMPLETED**: Integrate automatic backups into UpdateApp
   - Modified `UpdateApp` to check `backup_before_update` flag from app catalog
   - Creates backup via `internal/storage/backup.go` (BackupApp) with `StopBeforeBackup: true`
   - Stores backup ID in memory during update process
   - Implemented automatic rollback using `RestoreApp` if `ComposePull` or `ComposeUp` fails
   - Ensures consistency by stopping app during backup and restore

2. ✅ **COMPLETED**: Add update history tracking
   - Implemented `updates` table migrations (including `backup_id`)
   - Added `AppUpdate` struct and `ListUpdateHistory` method to `Manager`
   - Integrated logging into `UpdateApp` (records pending, success, failed, rolled_back states)
   - Exposed history via API: `GET /api/v1/apps/updates/history` and `GET /api/v1/apps/{id}/updates/history`

3. ✅ **COMPLETED**: Enhanced error handling and recovery
   - If update fails, automatically rollback to previous backup if one was created
   - Capture and log failure reasons in the `updates` table
   - Update history reflects the rollback status and links to the backup ID used

### Medium-term (Important)

4. ✅ **COMPLETED**: Implement update checking system
   - Compares currently installed app version (from DB metadata) with latest version in catalog
   - Added `GetAvailableUpdates` method to `Manager`
   - Added `GET /api/v1/apps/updates/available` endpoint
   - Fixed `Installer` to properly persist `version` in app metadata during installation
   - Includes tests verifying version mismatch detection

5. ✅ **COMPLETED**: Notification integration for available updates
   - Created `internal/notify` package for coordinated notifications
   - Implemented `AdminNotify` to retrieve all administrator emails and send notifications
   - Integrated with background `Scheduler` to send email alerts when app or platform updates are found
   - Honor SMTP configuration from `libreserv.yaml`

6. ✅ **COMPLETED**: Scheduled update checks
   - Implemented background `Scheduler` in `internal/jobs`
   - Configured 24-hour periodic checks for both apps and platform updates
   - Integrated scheduler into main application lifecycle with graceful shutdown
   - Shares unified `UpdateChecker` with API handlers for consistency

7. ✅ **COMPLETED**: Update channels and version pinning
   - Added `pinned_version` column to `apps` table via migration
   - Implemented `PinAppVersion` and `UnpinAppVersion` in `Manager`
   - Modified `GetAvailableUpdates` to respect version pins (ignores updates if pinned)
   - Exposed API: `POST /api/v1/apps/{id}/pin` and `POST /api/v1/apps/{id}/unpin`
   - Added tests for pinning lifecycle and update suppression

### Long-term (Nice to Have)

8. ✅ **COMPLETED**: Automated updates with `strategy: auto`
   - Background `Scheduler` now identifies apps with `auto` strategy
   - Automatically triggers `UpdateApp` flow (including backups/rollbacks)
   - Sends success/failure email notifications specifically for automated actions
   - Maintains separate notification list for apps requiring manual updates

9. 📝 **TODO**: Staged rollouts and canary deployments
   - Update one instance first, monitor for issues
   - Gradual rollout across multiple instances
   - Automatic pause on error rate increase

10. 📝 **TODO**: Update scheduling and orchestration
    - UI for scheduling updates (specific date/time)
    - Batch update multiple apps
    - Dependency-aware update ordering
    - Update dry-run mode to preview changes

11. 📝 **TODO**: Enhanced monitoring and observability
    - Track resource usage before/after updates
    - Performance regression detection
    - Integration with monitoring system for post-update health
    - Update analytics dashboard

---

## LibreServ (Platform) Self-Update System

**Current State**: Traditional build-and-deploy. No Docker images, no release artifacts, no update mechanism. Version info exists but is not injected at build time.

### Short-term (Critical for Production)

1. ✅ **COMPLETED**: Implement proper version injection at build time
   - Updated `Makefile` to inject `Version`, `BuildTime`, and `GitCommit` via `-ldflags`
   - Added these variables to `HealthHandler.Version` in `internal/api/handlers/health.go`
   - Verified build works and reports version correctly

2. ✅ **COMPLETED**: Create release workflow
   - Added `.github/workflows/release.yml`
   - Automated Docker image build and push to GHCR on tag push
   - Automated multi-arch binary builds (linux/darwin, amd64/arm64) and GitHub Release creation

3. ✅ **COMPLETED**: Docker image for LibreServ
   - Created multi-stage `Dockerfile` in root directory
   - Builds both frontend and backend and packages them into a small alpine-based image
   - Includes docker-cli and docker-compose for managing app containers

4. ✅ **COMPLETED**: Docker Compose for LibreServ deployment
   - Created `docker-compose.yml` in root directory
   - Deploys LibreServ with a managed Caddy instance
   - Configured for Docker socket access and external Caddy admin API control

### Medium-term (Important)

5. ✅ **COMPLETED**: Update checking system
   - Implemented `UpdateChecker` in `internal/system` targeting Gitea API at `gt.plainskill.net`
   - Compares semantic versions (handling 'v' prefix and 'dev' builds)
   - Added `GET /api/v1/system/updates/check` endpoint (admin only)
   - Integrated with build-time version injection

6. ✅ **COMPLETED**: Database migration safety (Core)
   - Implemented proper migration tracking via `schema_migrations` table
   - Migrations now run in ACID transactions (automatic rollback on failure)
   - Automatic database backup created before running any pending migrations
   - Switched to `embed.FS` for reliable migration file management
   - Added legacy backfill checks for schema consistency

7. ✅ **COMPLETED**: Database migration safety (Enhanced)
   - Implemented dry-run validation: All pending migrations are tested in a rolling-back transaction before any are applied
   - Added automatic file-level rollback: If a migration fails, the database file is automatically restored from the pre-migration backup
   - Verified transactional integrity and restoration flow

8. ✅ **COMPLETED**: Installation script
   - Created `install.sh` for one-line deployments
   - Detects OS (Linux/Darwin) and Architecture (amd64/arm64)
   - Downloads latest binary from Gitea API
   - Sets up system user, directory structure, and default config
   - Configures systemd service for persistence on Linux

### Long-term (Nice to Have)

9. ✅ **COMPLETED**: System-wide Audit Logging
   - Implemented `internal/audit` service for structured event recording
   - Added `audit_log` table with indexing for high-performance queries
   - Integrated with App and System update handlers to record administrative actions
   - Exposed queryable API: `GET /api/v1/audit` (Admin only)
   - Automatically tracks actor (user), action, target, status, and metadata

10. ⏸️ **DEFERRED**: Staged rollouts and canary deployments
    - Require multi-instance orchestration layer (e.g. Swarm/K8s)

11. ⏸️ **DEFERRED**: Update channels (Stable/Beta/Nightly)
    - Ready for implementation; requires catalog tagging strategy

## Documentation & Guides

1. ✅ **COMPLETED**: Operator Guide: Installation & Setup
2. ✅ **COMPLETED**: Operator Guide: Update Management & Safety
3. ✅ **COMPLETED**: Operator Guide: Caddy & DNS-01 Configuration
4. ✅ **COMPLETED**: Disaster Recovery: Manual Restore Procedures
5. ✅ **COMPLETED**: Developer Guide: Architecture & Building

---

## Security Hardening - Future Enhancements

From Gitea Issue #11 (IMPROVEMENT items - deferred for future)

### Long-term Security Enhancements

1. ✅ **COMPLETED**: SAST Integration (Static Application Security Testing)
   - ✅ Added CI/CD pipeline for static code analysis
   - ✅ Integrated gosec (140 G104 errors fixed) and staticcheck
   - ✅ Zero staticcheck warnings (one real bug caught and fixed!)
   - ✅ Block commits with high-severity findings (high severity + high confidence)
   - ✅ Security team notifications configured for blocked commits

   **Note on staticcheck** (2025-01-31):
   - staticcheck 2025.1 works perfectly with Go 1.25 when compiled from source
   - Key fix: Use `go install honnef.co/go/tools/cmd/staticcheck@2025.1` instead of pre-built binary
   - Pre-built binary fails because it was compiled with Go 1.24, not Go 1.25
   - All three tools (gosec, staticcheck, govulncheck) now active in CI

2. 🔄 **PARTIALLY COMPLETED**: Vulnerability Scanning
   - ✅ Automated CVE scanning for dependencies (govulncheck in CI)
   - ⏸️ **DEFERRED**: Container image scanning (Trivy, Grype) - needs infra setup
   - ⏸️ **DEFERRED**: Weekly scan with alerts to maintainers - needs notification setup

3. 📝 **TODO**: Fuzz Testing
   - Implement go-fuzz or similar for input validation testing
   - Focus on parsing, template execution, and network handlers
   - Integrate with CI for continuous fuzzing

4. 📝 **TODO**: Security Documentation
   - Document security architecture and design decisions
   - Incident response procedures
   - Security hardening guide for production deployments

5. 📝 **TODO**: Threat Modeling
   - Conduct threat modeling sessions for new features
   - Document attack surfaces and mitigations
   - STRIDE-based analysis for major components

6. 📝 **TODO**: Security Monitoring
   - Enhanced logging for security events
   - Anomaly detection patterns
   - Integration with SIEM or monitoring systems

7. 📝 **TODO**: Docker Security Documentation
   - Best practices for container security
   - Non-root user configuration
   - Resource limits and seccomp/AppArmor profiles

### Current Security Status
- **Code Quality**: All staticcheck warnings resolved; gosec analysis active
- **Error Handling**: 140 unhandled errors now properly handled (G104)
- **CI/CD Security**: Full SAST scanning (gosec, staticcheck, govulncheck) integrated into build pipeline
- **Bug Found**: Ineffective break statement in JSON extraction fixed
- **Tests**: All 17 test packages passing

### Notes
- SAST integration (gosec + staticcheck + govulncheck) active on every push to main/master and weekly schedule
- staticcheck 2025.1 successfully running with Go 1.25 via source compilation
- Remaining 65 Gosec issues are non-G104 (file permissions, path traversal, etc.)
- These require architectural review and are lower priority than error handling
