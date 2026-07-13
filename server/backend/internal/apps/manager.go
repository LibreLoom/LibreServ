package apps

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

// Manager handles the lifecycle of installed apps
type Manager struct {
	mu             sync.RWMutex
	catalog        *Catalog
	repoSet        *RepoSet
	installer      *Installer
	portManager    *PortManager
	runtime        runtime.ContainerRuntime
	db             *database.DB
	backupService  *storage.BackupService
	appsDataDir    string
	logger         *slog.Logger
	monitor        *monitoring.Monitor
	metricsCache   *AppMetricsCache
	caddyManager   *network.CaddyManager
	backendMap     map[string][]string            // appID -> backend URLs (primary first)
	backendByName  map[string]map[string][]string // appID -> name -> backends
	scriptExecutor *ScriptExecutor
	updateMu       sync.Mutex
	updating       map[string]bool
}

// NewManager creates a new app Manager
func NewManager(
	catalogPath, appsDataDir string,
	runtime runtime.ContainerRuntime,
	db *database.DB,
	monitor *monitoring.Monitor,
	backupService *storage.BackupService,
	caddyManager *network.CaddyManager,
) (*Manager, error) {
	// Load catalog
	catalog, err := NewCatalog(catalogPath)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize catalog: %w", err)
	}

	m := &Manager{
		catalog:        catalog,
		runtime:        runtime,
		db:             db,
		backupService:  backupService,
		appsDataDir:    appsDataDir,
		logger:         slog.Default().With("component", "apps-manager"),
		monitor:        monitor,
		caddyManager:   caddyManager,
		backendMap:     make(map[string][]string),
		backendByName:  make(map[string]map[string][]string),
		scriptExecutor: NewScriptExecutorWithCatalog(slog.Default().With("component", "script-executor"), nil, appsDataDir, catalogPath),
		updating:       make(map[string]bool),
	}

	// Set up repair callback if monitor is available
	if monitor != nil {
		monitor.RepairCallback = m.handleRepair
	}

	// Initialize metrics cache
	m.metricsCache = NewAppMetricsCache(monitor, m.logger)

	// Initialize port manager
	m.portManager = NewPortManager(db, catalog, config.Get().Server.Port)
	if err := m.portManager.Init(); err != nil {
		m.logger.Warn("Failed to initialize port manager", "error", err)
		// Non-fatal — port allocation will still work, just without pre-existing port awareness
	}

	// Create installer
	m.installer = NewInstaller(catalog, runtime, db, appsDataDir, monitor, m.metricsCache, m.portManager)
	m.installer.SetCatalogPath(catalogPath)

	// Build and inject server context for templates and scripts
	cfg := config.Get()
	serverCtx := NewServerContext(ServerContextConfig{
		ServerPort:     cfg.Server.Port,
		ServerMode:     cfg.Server.Mode,
		ServerHost:     cfg.Server.Host,
		DefaultDomain:  cfg.Network.Caddy.DefaultDomain,
		CaddyMode:      cfg.Network.Caddy.Mode,
		ACMEEmail:      cfg.Network.ACME.External.Email,
		SMTPHost:       cfg.SMTP.Host,
		SMTPPort:       cfg.SMTP.Port,
		SMTPUsername:   cfg.SMTP.Username,
		SMTPPassword:   cfg.SMTP.Password,
		SMTPFrom:       cfg.SMTP.From,
		SMTPUseTLS:     cfg.SMTP.UseTLS,
		SMTPSkipVerify: cfg.SMTP.SkipVerify,
		TunnelEnabled:  cfg.Network.Tunnel.Enabled,
		TunnelProvider: cfg.Network.Tunnel.Provider,
		TunnelToken:    cfg.Network.Tunnel.Token,
		DNSProvider:    cfg.Network.DNS.Provider,
	})
	m.installer.SetServerContext(serverCtx)
	m.scriptExecutor.SetServerContext(serverCtx)

	// Set route cleanup callback for install failures
	if m.caddyManager != nil {
		m.installer.SetRouteCleanup(func(ctx context.Context, appID string) error {
			route, err := m.caddyManager.GetRouteByApp(appID)
			if err != nil || route == nil {
				return nil // No route to cleanup
			}
			m.logger.Info("Cleaning up route after install failure", "instance_id", appID, "route_id", route.ID)
			return m.caddyManager.RemoveRoute(ctx, route.ID)
		})
	}

	m.installer.SetBackendRegistrar(func(instanceID, backend, name string) {
		// Existing: Register for ACME/monitoring
		if name != "" {
			m.RegisterNamedBackend(instanceID, name, backend)
		} else {
			m.RegisterBackend(instanceID, backend)
		}

		// NEW: Check if this backend installation has domain config
		// Only create route for the primary backend (empty name), not named backends
		if m.caddyManager != nil && name == "" {
			app, err := m.GetInstalledApp(context.Background(), instanceID)
			if err == nil && app != nil && app.Config != nil {
				if domain, ok := app.Config["domain"].(string); ok && domain != "" {
					if subdomain, ok := app.Config["subdomain"].(string); ok && subdomain != "" {
						// Create Caddy route for this app
						route, err := m.caddyManager.AddRoute(
							context.Background(),
							subdomain,
							domain,
							backend,
							instanceID,
						)
						if err != nil {
							// Check if this is a duplicate error (expected on subsequent backend registrations)
							if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "UNIQUE") {
								m.logger.Debug("Route already exists (expected)", "instance_id", instanceID, "subdomain", subdomain)
							} else {
								m.logger.Warn("Failed to create route",
									"instance_id", instanceID,
									"subdomain", subdomain,
									"domain", domain,
									"error", err,
								)
							}
							// Non-blocking - don't fail install
						} else {
							m.logger.Info("Created route for app",
								"instance_id", instanceID,
								"subdomain", subdomain,
								"domain", domain,
								"route_id", route.ID,
							)
							// Store route_id in app config for cleanup
							if app.Config == nil {
								app.Config = make(map[string]interface{})
							}
							app.Config["route_id"] = route.ID
							// Update the app record in database (only update route_id, not entire config)
							if err := m.updateRouteIDInConfig(instanceID, route.ID); err != nil {
								m.logger.Warn("Failed to update route_id in app config",
									"instance_id", instanceID,
									"route_id", route.ID,
									"error", err,
								)
							}
						}
					}
				}
			}
		}
	})

	m.RebuildBackends(context.Background())

	return m, nil
}

// GetCatalog returns the app catalog
func (m *Manager) GetCatalog() *Catalog {
	if m.repoSet != nil {
		if rc := m.repoSet.GetCatalog(); rc != nil {
			return rc
		}
	}
	return m.catalog
}

// SetRepoSet wires the RepoSet into the Manager for catalog/manifest lookups.
func (m *Manager) SetRepoSet(rs *RepoSet) {
	m.repoSet = rs
	rs.SetRevocationCallback(m.CheckRevocations)
}

// ForcePullRepos forces a pull of all repositories regardless of freshness.
func (m *Manager) ForcePullRepos(ctx context.Context) error {
	if m.repoSet == nil {
		return fmt.Errorf("no repositories configured")
	}
	return m.repoSet.PullAll(ctx)
}

// GetRepoStatus returns the status of all configured repositories.
func (m *Manager) GetRepoStatus() []RepoStatus {
	if m.repoSet == nil {
		return nil
	}
	return m.repoSet.RepoStatus()
}

// TriggerRepoPull pulls repos if the last pull was more than an hour ago.
func (m *Manager) TriggerRepoPull(ctx context.Context) {
	if m.repoSet == nil {
		return
	}
	statuses := m.repoSet.RepoStatus()
	needsPull := len(statuses) == 0
	for _, s := range statuses {
		if s.Enabled && time.Since(s.LastPull) > time.Hour {
			needsPull = true
			break
		}
	}
	if needsPull {
		if err := m.repoSet.PullAll(ctx); err != nil {
			m.logger.Warn("freshness repo pull failed", "error", err)
		}
	}
}

// GetUPnPService returns the UPnP service (stub for future implementation)
func (m *Manager) GetUPnPService() *network.UPnPService {
	return nil
}

// GetPortManager returns the port manager
func (m *Manager) GetPortManager() *PortManager {
	return m.portManager
}

// Start begins the metrics cache collection
func (m *Manager) Start(ctx context.Context) {
	if m.metricsCache != nil {
		m.metricsCache.Start(ctx)
	}
}

// Stop halts the metrics cache collection
func (m *Manager) Stop() {
	if m.metricsCache != nil {
		m.metricsCache.Stop()
	}
}

// RefreshMetrics forces an immediate metrics refresh
func (m *Manager) RefreshMetrics(ctx context.Context) {
	if m.metricsCache != nil {
		m.metricsCache.RefreshNow(ctx)
	}
}

// GetMetricsCache returns the metrics cache for efficient metric retrieval
func (m *Manager) GetMetricsCache() *AppMetricsCache {
	return m.metricsCache
}

// GetBackendURL returns a backend URL for an app if known.
func (m *Manager) GetBackendURL(appID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if backends, ok := m.backendMap[appID]; ok && len(backends) > 0 {
		return backends[0]
	}
	return ""
}

// GetBackends returns all registered backends for an app ID (primary first).
func (m *Manager) GetBackends(appID string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]string(nil), m.backendMap[appID]...)
}

// GetBackendByName returns the first backend that matches a logical name for the app.
func (m *Manager) GetBackendByName(appID, name string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if name == "" {
		return ""
	}
	if names, ok := m.backendByName[appID]; ok {
		if backends := names[name]; len(backends) > 0 {
			return backends[0]
		}
	}
	return ""
}

// GetBackendByIndex returns a backend by its ordinal (0-based) for an app.
func (m *Manager) GetBackendByIndex(appID string, idx int) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if idx < 0 {
		return ""
	}
	if backends, ok := m.backendMap[appID]; ok && idx < len(backends) {
		return backends[idx]
	}
	return ""
}

// registerBackend registers a backend URL for an appID.
func (m *Manager) addBackend(appID, backend string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if appID == "" || backend == "" {
		return false
	}
	current := m.backendMap[appID]
	for _, b := range current {
		if b == backend {
			return false
		}
	}
	m.backendMap[appID] = append(current, backend)
	return true
}

func (m *Manager) registerBackend(appID, backend, name string) {
	added := m.addBackend(appID, backend)
	if name == "" && !added {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.backendByName[appID]; !ok {
		m.backendByName[appID] = make(map[string][]string)
	}
	if name == "" {
		return
	}
	list := m.backendByName[appID][name]
	for _, b := range list {
		if b == backend {
			m.backendByName[appID][name] = list
			return
		}
	}
	m.backendByName[appID][name] = append(list, backend)
}

// RegisterBackend records a backend URL for a given app ID (used by ACME/Caddy automation).
func (m *Manager) RegisterBackend(appID, backend string) {
	m.registerBackend(appID, backend, "")
}

// RegisterNamedBackend records a backend under a logical name (ui/api/admin) and keeps index list in sync.
func (m *Manager) RegisterNamedBackend(appID, name, backend string) {
	m.registerBackend(appID, backend, name)
}

// RebuildBackends rehydrates backend lookups from installed apps (useful at startup).
func (m *Manager) RebuildBackends(ctx context.Context) {
	apps, err := m.ListInstalledApps(ctx)
	if err != nil {
		m.logger.Warn("Failed to rebuild backends", "error", err)
		return
	}
	for _, app := range apps {
		for _, be := range m.inferBackends(app) {
			m.registerBackend(app.ID, be.backend, be.name)
		}
	}
}

// StartInstalledApps starts all installed apps that should be running.
func (m *Manager) StartInstalledApps(ctx context.Context) {
	if err := m.CleanupStaleInstallations(ctx); err != nil {
		m.logger.Warn("Failed to cleanup stale installations", "error", err)
	}

	apps, err := m.ListInstalledApps(ctx)
	if err != nil {
		m.logger.Warn("Failed to list installed apps for startup", "error", err)
		return
	}

	// Initialize metrics cache with existing app statuses
	if m.metricsCache != nil {
		for _, app := range apps {
			m.metricsCache.UpdateStatus(app.ID, app.Status)
		}
	}

	for _, app := range apps {
		composePath := filepath.Join(m.appsDataDir, app.ID, "docker-compose.yml")
		if _, err := os.Stat(composePath); os.IsNotExist(err) {
			m.logger.Warn("Compose file missing for app, marking as error", "instance_id", app.ID)
			m.updateStatus(ctx, app.ID, StatusError)
			continue
		}

		if app.Status == StatusRunning || app.Status == StatusInstalling {
			m.logger.Info("Starting app on boot", "instance_id", app.ID, "app_id", app.AppID)
			if err := m.runtime.ComposeUp(ctx, composePath); err != nil {
				m.logger.Error("Failed to start app on boot", "instance_id", app.ID, "error", err)
				m.updateStatus(ctx, app.ID, StatusError)
			} else {
				m.updateStatus(ctx, app.ID, StatusRunning)
			}
		}
	}
}

// GetInstaller returns the installer
func (m *Manager) GetInstaller() *Installer {
	return m.installer
}

// GetScriptExecutor returns the script executor
func (m *Manager) GetScriptExecutor() *ScriptExecutor {
	return m.scriptExecutor
}

// handleRepair is called by the monitor when an app fails health checks
func (m *Manager) handleRepair(instanceID string) {
	m.logger.Info("Auto-repair triggered", "instance_id", instanceID)

	app, err := m.GetInstalledApp(context.Background(), instanceID)
	if err != nil {
		m.logger.Warn("Repair failed: app not found", "instance_id", instanceID)
		return
	}

	catalogApp, err := m.GetCatalog().GetApp(app.AppID)
	if err != nil {
		m.logger.Warn("Repair failed: app not in catalog", "app_id", app.AppID)
		return
	}

	repairScript := m.scriptExecutor.GetSystemScriptPath(catalogApp.CatalogPath, "repair")
	if repairScript == "" {
		m.logger.Debug("No repair script found", "app_id", app.AppID)
		return
	}

	result, err := m.scriptExecutor.ExecuteAt(context.Background(), instanceID, repairScript, app.Path, app.Config)
	if err != nil || !result.Success {
		m.logger.Warn("Repair script failed", "app_id", app.AppID, "error", err, "output", result.Error)
		return
	}

	m.logger.Info("Repair completed successfully", "instance_id", instanceID)
}

// StartApp starts a stopped app
func (m *Manager) StartApp(ctx context.Context, instanceID string) error {
	m.logger.Info("Starting app", "instance_id", instanceID)

	app, err := m.GetInstalledApp(ctx, instanceID)
	if err != nil {
		return err
	}

	if app.RevocationNotice != nil && app.RevocationNotice.AcknowledgedAt == nil {
		return fmt.Errorf("this version has been recalled for security reasons and cannot be started right now")
	}

	composePath := filepath.Join(m.appsDataDir, instanceID, "docker-compose.yml")
	if err := m.runtime.ComposeUp(ctx, composePath); err != nil {
		return err
	}

	return m.updateStatus(ctx, instanceID, StatusRunning)
}

// StopApp stops a running app
func (m *Manager) StopApp(ctx context.Context, instanceID string) error {
	m.logger.Info("Stopping app", "instance_id", instanceID)

	composePath := filepath.Join(m.appsDataDir, instanceID, "docker-compose.yml")
	if err := m.runtime.ComposeStop(ctx, composePath); err != nil {
		return err
	}

	return m.updateStatus(ctx, instanceID, StatusStopped)
}

// RestartApp restarts an app
func (m *Manager) RestartApp(ctx context.Context, instanceID string) error {
	m.logger.Info("Restarting app", "instance_id", instanceID)

	if err := m.StopApp(ctx, instanceID); err != nil {
		return err
	}
	return m.StartApp(ctx, instanceID)
}

// GetAppStatus returns the current status of an app
func (m *Manager) GetAppStatus(ctx context.Context, instanceID string) (*AppStatusInfo, error) {
	app, err := m.GetInstalledApp(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	if app.Status == StatusInstalling || app.Status == StatusUpdating {
		return &AppStatusInfo{
			InstanceID: instanceID,
			Status:     app.Status,
			Containers: nil,
		}, nil
	}

	// If app has error status, return the error message
	if app.Status == StatusError {
		return &AppStatusInfo{
			InstanceID: instanceID,
			Status:     StatusError,
			Containers: nil,
			Error:      app.Error,
		}, nil
	}

	label := "libreserv.app=" + instanceID
	containers, err := m.runtime.ListContainersByLabel(ctx, label)
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}

	var (
		containerStatuses []ContainerStatus
		runningCount      int
		total             = len(containers)
	)

	for _, cinfo := range containers {
		state := cinfo.State
		if state == "" {
			state = "unknown"
		}
		if state == "running" {
			runningCount++
		}
		containerStatuses = append(containerStatuses, ContainerStatus{
			Name:   firstName(cinfo.Names),
			ID:     cinfo.ID,
			Status: cinfo.Status,
			Health: cinfo.State,
		})
	}

	var overall AppStatus
	if total == 0 {
		overall = StatusStopped
	} else if runningCount == total {
		overall = StatusRunning
	} else if runningCount == 0 {
		overall = StatusStopped
	} else {
		overall = StatusError
	}

	return &AppStatusInfo{
		InstanceID: instanceID,
		Status:     overall,
		Containers: containerStatuses,
	}, nil
}

// AppStatusInfo contains detailed status information about an app
type AppStatusInfo struct {
	InstanceID string            `json:"instance_id"`
	Status     AppStatus         `json:"status"`
	Containers []ContainerStatus `json:"containers"`
	Error      string            `json:"error,omitempty"`
}

// ContainerStatus contains status information about a single container
type ContainerStatus struct {
	Name   string `json:"name"`
	ID     string `json:"id"`
	Status string `json:"status"`
	Health string `json:"health,omitempty"`
}

// ListInstalledApps returns all installed apps
func (m *Manager) ListInstalledApps(ctx context.Context) ([]*InstalledApp, error) {
	rows, err := m.db.Query(`
		SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version, error, image_digest, compose_template_sha, revocation_severity, revocation_reason, revocation_revoked_at, revocation_acknowledged_at
		FROM apps
		ORDER BY installed_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("failed to query installed apps: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			m.logger.Warn("failed to close rows", "error", cerr)
		}
	}()

	var apps []*InstalledApp
	for rows.Next() {
		app, err := scanInstalledApp(rows)
		if err != nil {
			m.logger.Warn("Failed to scan installed app", "error", err)
			continue
		}
		app.Backends = m.listBackendRefs(app.ID)
		m.maybeSetPublicURL(app)

		// Populate exposed_info from catalog definition
		if catalogApp, err := m.GetCatalog().GetApp(app.AppID); err == nil {
			app.ExposedInfo = m.mergeExposedInfo(app, catalogApp)
		}

		// Populate metrics from cache
		if m.metricsCache != nil {
			metrics := m.metricsCache.GetMetrics(app.ID)
			app.CPUPercent = metrics.CPUPercent
			app.MemoryUsage = metrics.MemoryUsage
			app.MemoryLimit = metrics.MemoryLimit
			app.Uptime = metrics.Uptime
			app.Downtime = metrics.Downtime
			app.Availability = metrics.Availability
		}

		apps = append(apps, app)
	}

	return apps, nil
}

// GetInstalledApp returns a single installed app by instance ID
func (m *Manager) GetInstalledApp(ctx context.Context, instanceID string) (*InstalledApp, error) {
	row := m.db.QueryRow(`
		SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version, error, image_digest, compose_template_sha, revocation_severity, revocation_reason, revocation_revoked_at, revocation_acknowledged_at
		FROM apps WHERE id = ?
	`, instanceID)

	app, err := scanInstalledApp(row)
	if err != nil {
		return nil, fmt.Errorf("app not found: %s", instanceID)
	}

	app.Backends = m.listBackendRefs(app.ID)
	m.maybeSetPublicURL(app)

	catalogApp, err := m.GetCatalog().GetApp(app.AppID)
	if err == nil {
		app.ExposedInfo = m.mergeExposedInfo(app, catalogApp)
	}

	return app, nil
}

// UpdateApp updates an app to a newer version.
//
// Phase 3 changes:
//   - Per-app mutex prevents concurrent updates for the same app
//   - Sets StatusUpdating during the update
//   - Enforces pinned version (returns error unless overridePin=true)
//   - Blocks if manifest marks version as needs_config
//   - Keeps backup for 7 days instead of deleting on success
//   - Renders new compose template if SHA changed
//   - Pins image digest from manifest before pull
//   - Updates image_digest, compose_template_sha, version in DB on success
func (m *Manager) UpdateApp(ctx context.Context, instanceID string, overridePin bool) error {
	m.updateMu.Lock()
	if m.updating[instanceID] {
		m.updateMu.Unlock()
		return fmt.Errorf("update already in progress for app %s", instanceID)
	}
	m.updating[instanceID] = true
	defer func() {
		m.updateMu.Lock()
		delete(m.updating, instanceID)
		m.updateMu.Unlock()
	}()
	m.updateMu.Unlock()

	m.logger.Info("Updating app", "instance_id", instanceID)

	app, err := m.GetInstalledApp(ctx, instanceID)
	if err != nil {
		return err
	}

	prevStatus := app.Status

	catalogApp, err := m.GetCatalog().GetApp(app.AppID)
	if err != nil {
		return fmt.Errorf("app not found in catalog: %w", err)
	}

	manifest, _ := LoadManifest(catalogApp.CatalogPath)
	if manifest == nil {
		m.logger.Warn("No manifest available, updating without verification", "app_id", app.AppID, "instance_id", instanceID)
	}

	var targetVersion *ManifestVersion
	var newVersion string
	if manifest != nil {
		if latest := manifest.LatestApproved(); latest != nil {
			targetVersion = latest
			newVersion = latest.Tag
		}
	}
	if newVersion == "" {
		newVersion = catalogApp.Version
	}

	if app.PinnedVersion != "" && !overridePin {
		if app.PinnedVersion != newVersion {
			return fmt.Errorf("this app is pinned to version %s. If you want to update, confirm the update to override the pin", app.PinnedVersion)
		}
	}

	if targetVersion != nil && targetVersion.NeedsConfig {
		reason := targetVersion.NeedsConfigReason
		if reason == "" {
			reason = "This update needs some setup first."
		}
		return fmt.Errorf("needs_config: %s", reason)
	}

	oldVersion, _ := app.Config["version"].(string)
	if oldVersion == "" {
		oldVersion = app.PinnedVersion
	}

	if err := m.updateStatus(ctx, instanceID, StatusUpdating); err != nil {
		return fmt.Errorf("failed to set updating status: %w", err)
	}

	res, err := m.db.Exec(`
		INSERT INTO updates (app_id, status, old_version, new_version, started_at)
		VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
	`, instanceID, "pending", oldVersion, newVersion)
	var updateID int64
	if err == nil {
		updateID, _ = res.LastInsertId()
	}

	var backupID string
	if catalogApp.Updates.BackupBeforeUpdate {
		m.logger.Info("Creating backup before update", "instance_id", instanceID)

		backupScriptPath := m.scriptExecutor.GetSystemScriptPath(catalogApp.CatalogPath, "backup")
		if backupScriptPath != "" {
			result, err := m.scriptExecutor.ExecuteAt(ctx, instanceID, backupScriptPath, app.Path, app.Config)
			if err != nil || !result.Success {
				m.recordUpdateFailure(updateID, fmt.Errorf("backup script failed: %v, %s", err, result.Error), false, "")
				m.updateStatus(ctx, instanceID, prevStatus)
				return fmt.Errorf("backup script failed: %w", err)
			}
			if result.Data != nil {
				if id, ok := result.Data["backup_id"].(string); ok {
					backupID = id
				}
			}
			m.logger.Info("Backup created via script", "backup_id", backupID)
		} else {
			backupRes, err := m.backupService.BackupApp(ctx, instanceID, storage.BackupOptions{
				StopBeforeBackup: true,
			})
			if err != nil {
				m.recordUpdateFailure(updateID, fmt.Errorf("backup failed: %w", err), false, "")
				m.updateStatus(ctx, instanceID, prevStatus)
				return fmt.Errorf("backup failed: %w", err)
			}
			backupID = backupRes.Backup.ID
			m.logger.Info("Backup created successfully", "backup_id", backupID)
		}

		if updateID > 0 {
			_, _ = m.db.Exec(`UPDATE updates SET backup_id = ? WHERE id = ?`, backupID, updateID)
		}
	}

	composePath := filepath.Join(m.appsDataDir, instanceID, "docker-compose.yml")

	composeTemplateChanged := false
	if targetVersion != nil && targetVersion.ComposeTemplateSHA != "" && app.ComposeTemplateSHA != targetVersion.ComposeTemplateSHA {
		composeTemplateChanged = true
	}
	if app.ComposeTemplateSHA == "" && targetVersion != nil && targetVersion.ComposeTemplateSHA != "" {
		composeTemplateChanged = true
	}
	if composeTemplateChanged {
		m.logger.Info("Compose template changed, rendering new template", "instance_id", instanceID)
		app.Config["version"] = newVersion
		for _, field := range catalogApp.Configuration {
			if _, exists := app.Config[field.Name]; !exists {
				if field.Default != nil {
					app.Config[field.Name] = field.Default
				} else if field.Type == "password" {
					app.Config[field.Name] = generateSecurePassword(24)
				}
			}
		}
		// Re-validate existing config values against the updated catalog schema.
		if err := m.installer.ValidateConfig(catalogApp.ID, app.Config); err != nil {
			m.recordUpdateFailure(updateID, fmt.Errorf("config validation failed: %w", err), false, backupID)
			m.updateStatus(ctx, instanceID, prevStatus)
			return fmt.Errorf("config validation failed: %w", err)
		}
		app.Config["server"] = map[string]interface{}{
			"server_port":      m.installer.serverCtx.ServerPort,
			"server_mode":      m.installer.serverCtx.ServerMode,
			"server_host":      m.installer.serverCtx.ServerHost,
			"server_url":       m.installer.serverCtx.ServerURL,
			"default_domain":   m.installer.serverCtx.DefaultDomain,
			"caddy_mode":       m.installer.serverCtx.CaddyMode,
			"acme_email":       m.installer.serverCtx.ACMEEmail,
			"smtp_host":        m.installer.serverCtx.SMTPHost,
			"smtp_port":        m.installer.serverCtx.SMTPPort,
			"smtp_username":    m.installer.serverCtx.SMTPUsername,
			"smtp_password":    m.installer.serverCtx.SMTPPassword,
			"smtp_from":        m.installer.serverCtx.SMTPFrom,
			"smtp_use_tls":     m.installer.serverCtx.SMTPUseTLS,
			"smtp_skip_verify": m.installer.serverCtx.SMTPSkipVerify,
			"tunnel_enabled":   m.installer.serverCtx.TunnelEnabled,
			"tunnel_provider":  m.installer.serverCtx.TunnelProvider,
			"tunnel_token":     m.installer.serverCtx.TunnelToken,
			"dns_provider":     m.installer.serverCtx.DNSProvider,
		}
		_, err := m.installer.processComposeTemplate(catalogApp, filepath.Join(m.appsDataDir, instanceID), app.Config)
		if err != nil {
			m.recordUpdateFailure(updateID, fmt.Errorf("compose template render failed: %w", err), false, backupID)
			m.updateStatus(ctx, instanceID, prevStatus)
			return fmt.Errorf("compose template render failed: %w", err)
		}
	}

	if targetVersion != nil && targetVersion.Digest != "" {
		if err := podman.ComposePinImageDigest(composePath, catalogApp.Deployment.Image, targetVersion.Digest); err != nil {
			m.logger.Warn("Failed to pin image digest in compose file",
				"error", err,
				"instance_id", instanceID,
				"image", catalogApp.Deployment.Image,
				"digest", targetVersion.Digest,
				"compose_path", composePath)
		}
	}

	// Compute SHA after all compose file mutations (render + digest pin) are complete.
	// This ensures the stored SHA always matches the file on disk.
	finalSHA, _ := ComposeTemplateSHA(composePath)
	if finalSHA != "" {
		app.ComposeTemplateSHA = finalSHA
	}

	updateScriptPath := m.scriptExecutor.GetSystemScriptPath(catalogApp.CatalogPath, "update")
	if updateScriptPath != "" {
		m.logger.Info("Running system-update script", "instance_id", instanceID)
		result, err := m.scriptExecutor.ExecuteAt(ctx, instanceID, updateScriptPath, app.Path, app.Config)
		if err != nil || !result.Success {
			m.recordUpdateFailure(updateID, fmt.Errorf("system-update script failed: %v, %s", err, result.Error), false, backupID)
			m.updateStatus(ctx, instanceID, prevStatus)
			return fmt.Errorf("system-update script failed: %w", err)
		}
		m.logger.Info("system-update script completed", "instance_id", instanceID)
	}

	if err := m.runtime.ComposePull(ctx, composePath); err != nil {
		m.recordUpdateFailure(updateID, err, false, backupID)
		m.updateStatus(ctx, instanceID, prevStatus)
		return fmt.Errorf("failed to pull images: %w", err)
	}

	if err := m.runtime.ComposeUp(ctx, composePath); err != nil {
		rolledBack := false
		if backupID != "" {
			m.logger.Warn("Update failed during recreation, attempting rollback", "error", err)
			if _, rErr := m.backupService.RestoreApp(ctx, backupID, "", storage.RestoreOptions{
				StopBeforeRestore:   true,
				RestartAfterRestore: true,
			}); rErr != nil {
				m.logger.Error("Rollback failed", "error", rErr)
			} else {
				rolledBack = true
				// Recompute SHA from the restored compose file to keep DB consistent.
				if restoredSHA, err := ComposeTemplateSHA(composePath); err == nil && restoredSHA != "" {
					app.ComposeTemplateSHA = restoredSHA
					_, _ = m.db.Exec(`UPDATE apps SET compose_template_sha = ? WHERE id = ?`, restoredSHA, instanceID)
				}
			}
		}
		m.recordUpdateFailure(updateID, err, rolledBack, backupID)
		m.updateStatus(ctx, instanceID, prevStatus)
		return fmt.Errorf("failed to recreate containers: %w", err)
	}

	m.logger.Info("Verifying health after update", "instance_id", instanceID)
	isHealthy := m.waitForHealthy(ctx, instanceID, 60*time.Second)

	if !isHealthy {
		m.logger.Error("App unhealthy after update, initiating rollback", "instance_id", instanceID)
		rolledBack := false
		if backupID != "" {
			if _, rErr := m.backupService.RestoreApp(ctx, backupID, "", storage.RestoreOptions{
				StopBeforeRestore:   true,
				RestartAfterRestore: true,
			}); rErr != nil {
				m.logger.Error("Rollback failed after health check failure", "error", rErr)
			} else {
				rolledBack = true
				// Recompute SHA from the restored compose file to keep DB consistent.
				if restoredSHA, err := ComposeTemplateSHA(composePath); err == nil && restoredSHA != "" {
					app.ComposeTemplateSHA = restoredSHA
					_, _ = m.db.Exec(`UPDATE apps SET compose_template_sha = ? WHERE id = ?`, restoredSHA, instanceID)
				}
			}
		}
		m.recordUpdateFailure(updateID, fmt.Errorf("app unhealthy after update"), rolledBack, backupID)
		m.updateStatus(ctx, instanceID, prevStatus)
		return fmt.Errorf("app unhealthy after update (rollback attempted)")
	}

	if updateID > 0 {
		_, _ = m.db.Exec(`
			UPDATE updates 
			SET status = 'success', completed_at = CURRENT_TIMESTAMP 
			WHERE id = ?
		`, updateID)
	}

	// Store the rendered-file SHA (not the manifest template SHA) and the target digest.
	var newImageDigest string
	if targetVersion != nil {
		newImageDigest = targetVersion.Digest
	}

	_, _ = m.db.Exec(`
		UPDATE apps SET
			image_digest = ?,
			compose_template_sha = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, newImageDigest, app.ComposeTemplateSHA, instanceID)

	if app.Config == nil {
		app.Config = make(map[string]interface{})
	}
	app.Config["version"] = newVersion
	safeConfig := stripServerContext(app.Config)
	configJSON, _ := json.Marshal(safeConfig)
	_, _ = m.db.Exec(`UPDATE apps SET metadata = ? WHERE id = ?`, string(configJSON), instanceID)

	return m.updateStatus(ctx, instanceID, StatusRunning)
}

// waitForHealthy polls the app status until it becomes running or timeout expires.
func (m *Manager) waitForHealthy(ctx context.Context, instanceID string, timeout time.Duration) bool {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			status, err := m.GetAppStatus(ctx, instanceID)
			if err == nil && status.Status == StatusRunning {
				return true
			}
		}
	}
}

func (m *Manager) recordUpdateFailure(updateID int64, err error, rolledBack bool, backupID string) {
	if updateID <= 0 {
		return
	}
	status := "failed"
	if rolledBack {
		status = "rolled_back"
	}
	_, _ = m.db.Exec(`
		UPDATE updates 
		SET status = ?, completed_at = CURRENT_TIMESTAMP, error = ?, rolled_back = ?, backup_id = ?
		WHERE id = ?
	`, status, err.Error(), rolledBack, backupID, updateID)
}

// UninstallApp removes an installed app
func (m *Manager) UninstallApp(ctx context.Context, instanceID string) error {
	if m.monitor != nil {
		m.monitor.UnregisterApp(instanceID)
	}

	if err := m.installer.Uninstall(ctx, instanceID); err != nil {
		m.logger.Warn("Installer uninstall returned error, continuing with DB cleanup", "error", err)
	}

	// Release ports allocated to this app
	if m.portManager != nil {
		m.portManager.ReleaseAll(instanceID)
	}

	// Clean up routes for this app
	if m.caddyManager != nil {
		route, err := m.caddyManager.GetRouteByApp(instanceID)
		if err == nil && route != nil {
			m.logger.Info("Removing route during uninstall", "instance_id", instanceID, "route_id", route.ID)
			if err := m.caddyManager.RemoveRoute(ctx, route.ID); err != nil {
				m.logger.Warn("Failed to remove route", "instance_id", instanceID, "error", err)
			}
		}
	}

	// Clean up backend registrations
	m.removeBackendRegistrations(instanceID)

	if m.metricsCache != nil {
		m.metricsCache.RemoveApp(instanceID)
	}

	_, err := m.db.Exec(`DELETE FROM apps WHERE id = ?`, instanceID)
	return err
}

// CleanupStaleInstallations removes apps stuck in "installing" or "error" state for too long
func (m *Manager) CleanupStaleInstallations(ctx context.Context) error {
	cutoff := time.Now().Add(-30 * time.Minute)
	rows, err := m.db.Query(`SELECT id FROM apps WHERE (status = ? OR status = ?) AND installed_at < ?`, string(StatusInstalling), string(StatusError), cutoff)
	if err != nil {
		return fmt.Errorf("failed to query stale installations: %w", err)
	}
	defer rows.Close()

	var staleIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			continue
		}
		staleIDs = append(staleIDs, id)
	}

	for _, id := range staleIDs {
		m.logger.Info("Cleaning up stale installation", "instance_id", id)
		if err := m.UninstallApp(ctx, id); err != nil {
			m.logger.Warn("Failed to cleanup stale installation", "instance_id", id, "error", err)
		}
	}

	return nil
}

// ListUpdateHistory returns the update history for an app or all apps
func (m *Manager) ListUpdateHistory(ctx context.Context, instanceID string) ([]AppUpdate, error) {
	var query string
	var args []interface{}

	if instanceID != "" {
		query = `SELECT id, app_id, status, old_version, new_version, started_at, completed_at, error, rolled_back, backup_id 
				 FROM updates WHERE app_id = ? ORDER BY started_at DESC`
		args = append(args, instanceID)
	} else {
		query = `SELECT id, app_id, status, old_version, new_version, started_at, completed_at, error, rolled_back, backup_id 
				 FROM updates ORDER BY started_at DESC`
	}

	rows, err := m.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query update history: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			m.logger.Warn("failed to close rows", "error", cerr)
		}
	}()

	var updates []AppUpdate
	for rows.Next() {
		var u AppUpdate
		var completedAt *time.Time
		var errStr sql.NullString
		var rolledBack sql.NullBool
		var backupID sql.NullString
		if err := rows.Scan(&u.ID, &u.AppID, &u.Status, &u.OldVersion, &u.NewVersion, &u.StartedAt, &completedAt, &errStr, &rolledBack, &backupID); err != nil {
			m.logger.Warn("Failed to scan update record", "error", err)
			continue
		}
		u.CompletedAt = completedAt
		u.Error = errStr.String
		u.RolledBack = rolledBack.Bool
		u.BackupID = backupID.String
		updates = append(updates, u)
	}

	return updates, nil
}

// GetAvailableUpdates returns a list of available updates for all installed apps
func (m *Manager) GetAvailableUpdates(ctx context.Context) ([]AvailableUpdate, error) {
	installedApps, err := m.ListInstalledApps(ctx)
	if err != nil {
		return nil, err
	}

	available := make([]AvailableUpdate, 0)
	for _, app := range installedApps {
		catalogApp, err := m.GetCatalog().GetApp(app.AppID)
		if err != nil {
			continue
		}

		currentVersion, _ := app.Config["version"].(string)
		latestVersion := catalogApp.Version

		manifest, _ := LoadManifest(catalogApp.CatalogPath)
		digestTrackingEnabled := false
		currentDigest := app.ImageDigest
		latestDigest := ""
		composeTemplateChanged := false
		needsConfig := false
		needsConfigReason := ""
		isUpdate := false

		if manifest != nil {
			digestTrackingEnabled = currentDigest != ""
			if latest := manifest.LatestApproved(); latest != nil {
				latestVersion = latest.Tag
				latestDigest = latest.Digest
				needsConfig = latest.NeedsConfig
				needsConfigReason = latest.NeedsConfigReason
				if currentDigest != "" && currentDigest != latestDigest {
					isUpdate = true
				}
				if latest.ComposeTemplateSHA != "" && app.ComposeTemplateSHA != latest.ComposeTemplateSHA {
					composeTemplateChanged = true
				}
			}
		} else {
			if app.PinnedVersion == "" {
				isUpdate = currentVersion != "" && currentVersion != latestVersion
			}
		}

		if isUpdate && app.PinnedVersion != "" && currentVersion != app.PinnedVersion {
			isUpdate = false
		}

		available = append(available, AvailableUpdate{
			InstanceID:             app.ID,
			AppID:                  app.AppID,
			AppName:                app.Name,
			CurrentVersion:         currentVersion,
			LatestVersion:          latestVersion,
			CurrentDigest:          currentDigest,
			LatestDigest:           latestDigest,
			ComposeTemplateChanged: composeTemplateChanged,
			NeedsConfig:            needsConfig,
			NeedsConfigReason:      needsConfigReason,
			IsUpdate:               isUpdate,
			DigestTrackingEnabled:  digestTrackingEnabled,
		})
	}

	return available, nil
}

// PinAppVersion locks an app to a specific version
func (m *Manager) PinAppVersion(ctx context.Context, instanceID string, version string) error {
	_, err := m.db.Exec(`UPDATE apps SET pinned_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, version, instanceID)
	if err != nil {
		return fmt.Errorf("failed to pin app version: %w", err)
	}
	m.logger.Info("App version pinned", "instance_id", instanceID, "version", version)
	return nil
}

// UnpinAppVersion removes version lock from an app
func (m *Manager) UnpinAppVersion(ctx context.Context, instanceID string) error {
	_, err := m.db.Exec(`UPDATE apps SET pinned_version = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, instanceID)
	if err != nil {
		return fmt.Errorf("failed to unpin app version: %w", err)
	}
	m.logger.Info("App version unpinned", "instance_id", instanceID)
	return nil
}

// CheckRevocations checks installed apps against manifests for revoked versions.
func (m *Manager) CheckRevocations(ctx context.Context) error {
	rows, err := m.db.Query(`
		SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version, error, image_digest, compose_template_sha, revocation_severity, revocation_reason, revocation_revoked_at, revocation_acknowledged_at
		FROM apps
		WHERE status IN ('running', 'stopped') AND revocation_severity IS NULL
	`)
	if err != nil {
		return fmt.Errorf("failed to query apps for revocation check: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		app, err := scanInstalledApp(rows)
		if err != nil {
			m.logger.Warn("Failed to scan app for revocation check", "error", err)
			continue
		}

		catalogApp, err := m.GetCatalog().GetApp(app.AppID)
		if err != nil {
			continue
		}

		manifest, err := LoadManifest(catalogApp.CatalogPath)
		if err != nil || manifest == nil {
			continue
		}

		currentVersion, _ := app.Config["version"].(string)
		if currentVersion == "" {
			continue
		}

		revoked, ok := manifest.IsRevoked(currentVersion)
		if !ok {
			continue
		}

		m.logger.Warn("Revoked app version detected",
			"instance_id", app.ID,
			"app_id", app.AppID,
			"version", currentVersion,
			"severity", revoked.Severity,
		)

		if revoked.Severity == "malicious" && app.Status == StatusRunning {
			composePath := filepath.Join(m.appsDataDir, app.ID, "docker-compose.yml")
			stopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if err := m.runtime.ComposeStop(stopCtx, composePath); err != nil {
				m.logger.Warn("Failed to gracefully stop revoked malicious app", "instance_id", app.ID, "error", err)
				downCtx, downCancel := context.WithTimeout(ctx, 5*time.Second)
				_ = m.runtime.ComposeDown(downCtx, composePath)
				downCancel()
			}
			cancel()
		}

		revokedAt := time.Now()
		if revoked.RevokedAt != nil && !revoked.RevokedAt.IsZero() {
			revokedAt = *revoked.RevokedAt
		}
		_, _ = m.db.Exec(`
			UPDATE apps SET
				status = 'revoked',
				revocation_severity = ?,
				revocation_reason = ?,
				revocation_revoked_at = ?,
				updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, revoked.Severity, revoked.RevocationReason, revokedAt, app.ID)

		if m.metricsCache != nil {
			m.metricsCache.UpdateStatus(app.ID, StatusRevoked)
		}
	}

	return nil
}

// AcknowledgeRevocation marks a revoked app's revocation notice as acknowledged by the user.
func (m *Manager) AcknowledgeRevocation(ctx context.Context, instanceID string) error {
	res, err := m.db.Exec(`
		UPDATE apps SET revocation_acknowledged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND revocation_severity IS NOT NULL AND revocation_acknowledged_at IS NULL
	`, instanceID)
	if err != nil {
		return fmt.Errorf("failed to acknowledge revocation: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return fmt.Errorf("no unacknowledged revocation found for app %s", instanceID)
	}
	m.logger.Info("Revocation acknowledged", "instance_id", instanceID)
	return nil
}

// RefreshCatalog reloads the app catalog from disk
func (m *Manager) RefreshCatalog() error {
	return m.GetCatalog().Refresh()
}

// Close cleans up manager resources
func (m *Manager) Close() error {
	return m.db.Close()
}

// updateRouteIDInConfig updates only the route_id in an app's config
func (m *Manager) updateRouteIDInConfig(instanceID, routeID string) error {
	// Fetch the current app config (no lock needed - direct DB read)
	var currentConfigJSON []byte
	err := m.db.QueryRow(`
		SELECT metadata FROM apps WHERE id = ?
	`, instanceID).Scan(&currentConfigJSON)

	if err != nil {
		return fmt.Errorf("failed to fetch app config: %w", err)
	}

	// Parse the current config
	var currentConfig map[string]interface{}
	if err := json.Unmarshal(currentConfigJSON, &currentConfig); err != nil {
		return fmt.Errorf("failed to unmarshal config: %w", err)
	}

	// Update only the route_id field
	if currentConfig == nil {
		currentConfig = make(map[string]interface{})
	}
	currentConfig["route_id"] = routeID

	// Serialize
	newConfigJSON, err := json.Marshal(currentConfig)
	if err != nil {
		return fmt.Errorf("failed to marshal new config: %w", err)
	}

	// Update database (no lock needed - DB handles concurrency)
	_, err = m.db.Exec(`
		UPDATE apps
		SET metadata = ?, updated_at = ?
		WHERE id = ?
	`, newConfigJSON, time.Now(), instanceID)

	if err != nil {
		return fmt.Errorf("failed to update route_id: %w", err)
	}

	return nil
}

// removeBackendRegistrations removes backend registrations for an app
func (m *Manager) removeBackendRegistrations(appID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Remove from backendMap
	delete(m.backendMap, appID)

	// Remove from backendByName
	delete(m.backendByName, appID)
}

// updateStatus updates the status and updated_at fields for an app
func (m *Manager) updateStatus(ctx context.Context, instanceID string, status AppStatus) error {
	// Update metrics cache with new status
	if m.metricsCache != nil {
		m.metricsCache.UpdateStatus(instanceID, status)
	}

	_, err := m.db.Exec(`UPDATE apps SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, string(status), instanceID)
	return err
}

// scanInstalledApp converts a SQL row into an InstalledApp
func scanInstalledApp(scanner interface {
	Scan(dest ...interface{}) error
}) (*InstalledApp, error) {
	var (
		id, name, appType, source, path, status, healthStatus string
		installedAt, updatedAt                                time.Time
		metadataJSON                                          string
		pinnedVersion                                         sql.NullString
		errMsg                                                sql.NullString
		imageDigest                                           sql.NullString
		composeTemplateSHA                                    sql.NullString
		revocationSeverity                                    sql.NullString
		revocationReason                                      sql.NullString
		revocationRevokedAt                                   sql.NullTime
		revocationAcknowledgedAt                              sql.NullTime
	)

	if err := scanner.Scan(&id, &name, &appType, &source, &path, &status, &healthStatus, &installedAt, &updatedAt, &metadataJSON, &pinnedVersion, &errMsg, &imageDigest, &composeTemplateSHA, &revocationSeverity, &revocationReason, &revocationRevokedAt, &revocationAcknowledgedAt); err != nil {
		return nil, err
	}

	config := make(map[string]interface{})
	if metadataJSON != "" {
		if err := json.Unmarshal([]byte(metadataJSON), &config); err != nil {
			slog.Warn("Failed to unmarshal app metadata", "id", id, "error", err)
		}
	}

	app := &InstalledApp{
		ID:                 id,
		AppID:              source,
		Name:               name,
		Type:               AppType(appType),
		Status:             AppStatus(status),
		HealthStatus:       HealthStatus(healthStatus),
		Path:               path,
		Config:             config,
		InstalledAt:        installedAt,
		UpdatedAt:          updatedAt,
		PinnedVersion:      pinnedVersion.String,
		Error:              errMsg.String,
		ImageDigest:        imageDigest.String,
		ComposeTemplateSHA: composeTemplateSHA.String,
	}

	if revocationSeverity.Valid && revocationSeverity.String != "" {
		var ackTime *time.Time
		if revocationAcknowledgedAt.Valid {
			ackTime = &revocationAcknowledgedAt.Time
		}
		app.RevocationNotice = &RevocationNotice{
			Severity:       revocationSeverity.String,
			Reason:         revocationReason.String,
			RevokedAt:      revocationRevokedAt.Time,
			AcknowledgedAt: ackTime,
		}
	}

	return app, nil
}

type backendEntry struct {
	name    string
	backend string
}

func (m *Manager) listBackendRefs(appID string) []BackendRef {
	refs := []BackendRef{}
	seen := make(map[string]bool)
	for _, b := range m.GetBackends(appID) {
		if seen[b] {
			continue
		}
		seen[b] = true
		refs = append(refs, BackendRef{URL: b})
	}
	// overlay names if available
	m.mu.RLock()
	defer m.mu.RUnlock()
	if names, ok := m.backendByName[appID]; ok {
		for name, list := range names {
			for _, b := range list {
				key := name + "|" + b
				if seen[key] {
					continue
				}
				seen[key] = true
				refs = append(refs, BackendRef{Name: name, URL: b})
			}
		}
	}
	return refs
}

// maybeSetPublicURL replaces a localhost-only app URL with the public route
// URL when a Caddy route exists for the app. This ensures "Open App" links
// in the UI point at the real domain instead of an internal port.
func (m *Manager) maybeSetPublicURL(app *InstalledApp) {
	if app == nil || m.caddyManager == nil {
		return
	}

	cfg := m.caddyManager.Config()
	if cfg.Mode == "disabled" {
		return
	}

	route, err := m.caddyManager.GetRouteByApp(app.ID)
	if err != nil || route == nil {
		return
	}

	scheme := "http"
	if cfg.AutoHTTPS {
		scheme = "https"
	}

	app.URL = fmt.Sprintf("%s://%s", scheme, route.FullDomain())
}

// EnsurePublicURL is the exported wrapper around maybeSetPublicURL so the
// install handler can populate an installed app's public URL (with the
// correct http/https scheme) before returning it to the UI. Without this the
// install response carries a localhost URL and the UI's "Open App" link
// points at the wrong place.
func (m *Manager) EnsurePublicURL(app *InstalledApp) {
	m.maybeSetPublicURL(app)
}

// inferBackends attempts to derive reachable backend URLs for an installed app.
func (m *Manager) inferBackends(app *InstalledApp) []backendEntry {
	if app == nil {
		return nil
	}
	var backends []backendEntry
	if app.URL != "" {
		backends = append(backends, backendEntry{backend: app.URL})
	}

	// Determine bind host from config
	host := "127.0.0.1"
	if cfg := config.Get(); cfg != nil {
		if h := cfg.Server.Host; h != "" && h != "0.0.0.0" {
			host = h
		}
	}

	if m.GetCatalog() != nil {
		if def, err := m.GetCatalog().GetApp(app.AppID); err == nil {
			// Build a map of config field names to user-provided values
			configValues := make(map[string]interface{})
			if app.Config != nil {
				for k, v := range app.Config {
					configValues[k] = v
				}
			}

			// Build a map from catalog default port values to config field names
			// This allows us to look up config overrides when port names are empty
			defaultPortToFieldName := make(map[int]string)
			for _, field := range def.Configuration {
				if field.Type == "port" {
					if d := toInt(field.Default); d > 0 {
						defaultPortToFieldName[d] = field.Name
					}
				}
			}

			for _, p := range def.Deployment.Ports {
				if p.Host > 0 || p.Name != "" {
					// Check if user overrode this port in config
					port := p.Host
					// First try matching by port name
					if configPort, ok := configValues[p.Name]; ok {
						port = toInt(configPort)
					} else if fieldName, ok := defaultPortToFieldName[p.Host]; ok {
						// Fallback: match by catalog default port -> config field name
						if configPort, ok := configValues[fieldName]; ok {
							port = toInt(configPort)
						}
					}
					// Only add if we have a valid port
					if port > 0 {
						backends = append(backends, backendEntry{
							backend: fmt.Sprintf("http://%s:%d", host, port),
							name:    p.Name,
						})
					}
				}
			}
			for _, b := range def.Deployment.Backends {
				if b.URL == "" {
					continue
				}
				backends = append(backends, backendEntry{
					backend: b.URL,
					name:    b.Name,
				})
			}
		}
	}
	return backends
}

func firstName(names []string) string {
	if len(names) == 0 {
		return ""
	}
	n := names[0]
	if len(n) > 0 && n[0] == '/' {
		return n[1:]
	}
	return n
}

func (m *Manager) mergeExposedInfo(app *InstalledApp, catalogApp *AppDefinition) map[string]ExposedInfoValue {
	merged := make(map[string]ExposedInfoValue)

	for _, field := range catalogApp.ExposedInfo {
		val, ok := app.Config[field.Name]
		if !ok {
			continue
		}
		merged[field.Name] = ExposedInfoValue{
			Label:         field.Label,
			Description:   field.Description,
			Type:          field.Type,
			Group:         field.Group,
			Advanced:      field.Advanced,
			Value:         val,
			Copyable:      field.Copyable,
			Revealable:    field.Revealable,
			MaskByDefault: field.MaskByDefault,
		}
	}

	return merged
}

var serverContextKeys = map[string]bool{
	"server.mode":                  true,
	"network.caddy.mode":           true,
	"network.caddy.default_domain": true,
	"network.caddy.email":          true,
	"network.caddy.auto_https":     true,
	"smtp.host":                    true,
	"smtp.port":                    true,
	"smtp.username":                true,
	"smtp.password":                true,
	"smtp.from":                    true,
	"smtp.use_tls":                 true,
	"smtp.skip_verify":             true,
}

// PropagateServerContext re-renders compose templates for all running apps
// with the current server context and recreates containers whose compose changed.
func (m *Manager) PropagateServerContext(ctx context.Context, changedKeys []string) {
	affectsServerCtx := false
	for _, k := range changedKeys {
		if serverContextKeys[k] {
			affectsServerCtx = true
			break
		}
	}
	if !affectsServerCtx {
		return
	}

	cfg := config.Get()
	newCtx := NewServerContext(ServerContextConfig{
		ServerPort:     cfg.Server.Port,
		ServerMode:     cfg.Server.Mode,
		ServerHost:     cfg.Server.Host,
		DefaultDomain:  cfg.Network.Caddy.DefaultDomain,
		CaddyMode:      cfg.Network.Caddy.Mode,
		ACMEEmail:      cfg.Network.ACME.External.Email,
		SMTPHost:       cfg.SMTP.Host,
		SMTPPort:       cfg.SMTP.Port,
		SMTPUsername:   cfg.SMTP.Username,
		SMTPPassword:   cfg.SMTP.Password,
		SMTPFrom:       cfg.SMTP.From,
		SMTPUseTLS:     cfg.SMTP.UseTLS,
		SMTPSkipVerify: cfg.SMTP.SkipVerify,
		TunnelEnabled:  cfg.Network.Tunnel.Enabled,
		TunnelProvider: cfg.Network.Tunnel.Provider,
		TunnelToken:    cfg.Network.Tunnel.Token,
		DNSProvider:    cfg.Network.DNS.Provider,
	})
	m.installer.SetServerContext(newCtx)
	m.scriptExecutor.SetServerContext(newCtx)

	apps, err := m.ListInstalledApps(ctx)
	if err != nil {
		m.logger.Error("Failed to list apps for server context propagation", "error", err)
		return
	}

	serverMap := map[string]interface{}{
		"server_port":      newCtx.ServerPort,
		"server_mode":      newCtx.ServerMode,
		"server_host":      newCtx.ServerHost,
		"server_url":       newCtx.ServerURL,
		"default_domain":   newCtx.DefaultDomain,
		"caddy_mode":       newCtx.CaddyMode,
		"acme_email":       newCtx.ACMEEmail,
		"smtp_host":        newCtx.SMTPHost,
		"smtp_port":        newCtx.SMTPPort,
		"smtp_username":    newCtx.SMTPUsername,
		"smtp_password":    newCtx.SMTPPassword,
		"smtp_from":        newCtx.SMTPFrom,
		"smtp_use_tls":     newCtx.SMTPUseTLS,
		"smtp_skip_verify": newCtx.SMTPSkipVerify,
		"tunnel_enabled":   newCtx.TunnelEnabled,
		"tunnel_provider":  newCtx.TunnelProvider,
		"tunnel_token":     newCtx.TunnelToken,
		"dns_provider":     newCtx.DNSProvider,
	}

	for _, app := range apps {
		if app.Status != StatusRunning {
			continue
		}

		// Skip apps currently being updated to avoid a data race on the compose file.
		m.updateMu.Lock()
		if m.updating[app.ID] {
			m.updateMu.Unlock()
			m.logger.Info("Skipping server context propagation for app with in-flight update",
				"instance_id", app.ID)
			continue
		}
		m.updateMu.Unlock()
		catalogApp, err := m.catalog.GetApp(app.AppID)
		if err != nil {
			m.logger.Warn("Failed to get catalog app for propagation", "app_id", app.AppID, "error", err)
			continue
		}
		if catalogApp.Deployment.ComposeFile == "" {
			continue
		}

		app.Config["server"] = serverMap

		composePath := filepath.Join(app.Path, "docker-compose.yml")
		oldContent, _ := os.ReadFile(composePath)

		newPath, err := m.installer.processComposeTemplate(catalogApp, app.Path, app.Config)
		if err != nil {
			m.logger.Warn("Failed to re-render compose for server context propagation",
				"instance_id", app.ID, "error", err)
			continue
		}

		newContent, _ := os.ReadFile(newPath)
		if string(oldContent) == string(newContent) {
			continue
		}

		m.logger.Info("Recreating app containers due to server context change",
			"instance_id", app.ID, "app_id", app.AppID)

		if err := m.runtime.ComposeUp(ctx, newPath); err != nil {
			m.logger.Warn("Failed to recreate containers after server context change",
				"instance_id", app.ID, "error", err)
		}
	}
}
