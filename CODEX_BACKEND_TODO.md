# Backend Hardening TODO

**Last Updated**: 2024-12-22

## Summary

**Completion Status**: 🎉 **MAJOR MILESTONE ACHIEVED** - Core hardening completed!

- ✅ **9 of 11** major items completed
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

**Remaining Work**:
- Documentation for operators (how-to guides)
- Optional enhancements (metrics, audit logging, job persistence)

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

1. 📝 **TODO**: Integrate automatic backups into UpdateApp
   - Before updating, check app's `backup_before_update` flag
   - Create backup via existing `internal/storage/backup.go`
   - Store backup reference for potential rollback
   - Implement rollback function to restore from pre-update backup

2. 📝 **TODO**: Add update history tracking
   - Create `app_updates` table: `(id, app_id, from_version, to_version, timestamp, status, backup_id)`
   - Log all update attempts (success/failure)
   - Expose update history via API

3. 📝 **TODO**: Enhanced error handling and recovery
   - If update fails, automatically rollback to previous backup
   - Capture and log failure reasons
   - Send notification on update failure

### Medium-term (Important)

4. 📝 **TODO**: Implement update checking system
   - Query Docker registry APIs for new image versions
   - Compare with currently running image digests
   - Store "update available" status per app
   - Add `GET /api/apps/updates/available` endpoint

5. 📝 **TODO**: Notification integration for available updates
   - Honor `strategy: notify` from app configs
   - Send email notifications via existing `internal/email/email.go`
   - Add in-app notification badges
   - Configurable notification preferences (immediate, daily digest, weekly)

6. 📝 **TODO**: Scheduled update checks
   - Background job to check for updates (daily/weekly configurable)
   - Store check results in database
   - Rate-limit registry API calls

7. 📝 **TODO**: Update channels and version pinning
   - Support for stable/beta/latest channels
   - Allow pinning to specific major/minor versions
   - Respect semantic versioning in update decisions

### Long-term (Nice to Have)

8. 📝 **TODO**: Automated updates with `strategy: auto`
   - Implement auto-update for apps configured with `strategy: auto`
   - Configurable maintenance windows
   - Pre-flight health checks before applying updates
   - Post-update health validation with automatic rollback on failure

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

1. 📝 **TODO**: Implement proper version injection at build time
   - Update Makefile to inject version, build time, git commit via `-ldflags`
   - Set version from git tags or environment variable
   - Document versioning scheme (semantic versioning)

2. 📝 **TODO**: Create release workflow
   - GitHub Actions workflow for creating releases
   - Automated changelog generation from commits/PRs
   - Tag-based release triggers (`v*` tags)
   - Build artifacts for multiple platforms (linux/amd64, linux/arm64, darwin/amd64, darwin/arm64)

3. 📝 **TODO**: Docker image for LibreServ
   - Multi-stage Dockerfile for backend
   - Include frontend build in image
   - Publish to GitHub Container Registry (ghcr.io)
   - Tag images with version numbers and `latest`
   - Health check endpoint integration

4. 📝 **TODO**: Docker Compose for LibreServ deployment
   - Example docker-compose.yml for running LibreServ
   - Volume mounts for data/config/logs
   - Network configuration for app containers
   - Integration with Caddy container

### Medium-term (Important)

5. 📝 **TODO**: Update checking system
   - Check GitHub Releases API for newer versions
   - Compare semantic versions
   - Display "update available" notification in UI
   - API endpoint: `GET /api/system/updates/check`

6. 📝 **TODO**: Database migration safety
   - Version migrations properly (track in migrations table)
   - Pre-update backup creation
   - Migration dry-run capability
   - Automatic rollback on migration failure

7. 📝 **TODO**: Installation script
   - One-line installer: `curl -fsSL https://get.libreserv.io | sh`
   - Detects OS/architecture
   - Downloads appropriate binary
   - Sets up systemd service
   - Creates default config
   - Handles updates via same script

8. 📝 **TODO**: Package managers
   - .deb packages for Debian/Ubuntu
   - .rpm packages for RHEL/Fedora/Rocky
   - APT/YUM repository hosting
   - GPG signing of packages

### Long-term (Nice to Have)

9. 📝 **TODO**: In-place update mechanism
   - Download new binary
   - Verify checksum/signature
   - Stop service gracefully
   - Backup current binary
   - Replace with new binary
   - Run migrations
   - Restart service
   - Health check validation
   - Automatic rollback on failure

10. 📝 **TODO**: Zero-downtime updates (Docker)
    - Blue-green deployment support
    - Rolling updates for multiple instances
    - Load balancer integration
    - Database migration coordination
    - Session persistence during updates

11. 📝 **TODO**: Update channels
    - Stable channel (production-ready)
    - Beta channel (preview features)
    - Nightly channel (latest builds)
    - Channel configuration per instance
    - Automatic beta testing program

12. 📝 **TODO**: Observability and rollback
    - Metrics before/after update
    - Error rate monitoring post-update
    - Automatic rollback triggers
    - Manual rollback endpoint: `POST /api/system/rollback`
    - Update history and audit log
