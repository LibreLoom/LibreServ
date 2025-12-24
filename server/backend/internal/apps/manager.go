package apps

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

// Manager handles the lifecycle of installed apps
type Manager struct {
	mu            sync.RWMutex
	catalog       *Catalog
	installer     *Installer
	docker        *docker.Client
	db            *database.DB
	backupService *storage.BackupService
	appsDataDir   string
	logger        *slog.Logger
	monitor       *monitoring.Monitor
	backendMap    map[string][]string            // appID -> backend URLs (primary first)
	backendByName map[string]map[string][]string // appID -> name -> backends
}

// NewManager creates a new app Manager
func NewManager(catalogPath, appsDataDir string, dockerClient *docker.Client, db *database.DB, monitor *monitoring.Monitor, backupService *storage.BackupService) (*Manager, error) {
	// Load catalog
	catalog, err := NewCatalog(catalogPath)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize catalog: %w", err)
	}

	m := &Manager{
		catalog:       catalog,
		docker:        dockerClient,
		db:            db,
		backupService: backupService,
		appsDataDir:   appsDataDir,
		logger:        slog.Default().With("component", "apps-manager"),
		monitor:       monitor,
		backendMap:    make(map[string][]string),
		backendByName: make(map[string]map[string][]string),
	}

	// Create installer
	m.installer = NewInstaller(catalog, dockerClient, db, appsDataDir, monitor)
	m.installer.SetBackendRegistrar(func(appID, backend, name string) {
		if name != "" {
			m.RegisterNamedBackend(appID, name, backend)
			return
		}
		m.RegisterBackend(appID, backend)
	})
	m.RebuildBackends(context.Background())

	return m, nil
}

// GetCatalog returns the app catalog
func (m *Manager) GetCatalog() *Catalog {
	return m.catalog
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
			m.registerBackend(app.AppID, be.backend, be.name)
		}
	}
}

// GetInstaller returns the installer
func (m *Manager) GetInstaller() *Installer {
	return m.installer
}

// StartApp starts a stopped app
func (m *Manager) StartApp(ctx context.Context, instanceID string) error {
	m.logger.Info("Starting app", "instance_id", instanceID)

	composePath := filepath.Join(m.appsDataDir, instanceID, "docker-compose.yml")
	if err := m.docker.ComposeUp(ctx, composePath); err != nil {
		return err
	}

	return m.updateStatus(ctx, instanceID, StatusRunning)
}

// StopApp stops a running app
func (m *Manager) StopApp(ctx context.Context, instanceID string) error {
	m.logger.Info("Stopping app", "instance_id", instanceID)

	composePath := filepath.Join(m.appsDataDir, instanceID, "docker-compose.yml")
	if err := m.docker.ComposeStop(ctx, composePath); err != nil {
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

	label := "libreserv.app=" + instanceID
	containers, err := m.docker.ListContainersByLabel(label)
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
			Health: cinfo.State, // placeholder; Docker API health requires inspection
		})
	}

	overall := app.Status
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
		SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version
		FROM apps
		ORDER BY installed_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("failed to query installed apps: %w", err)
	}
	defer rows.Close()

	var apps []*InstalledApp
	for rows.Next() {
		app, err := scanInstalledApp(rows)
		if err != nil {
			m.logger.Warn("Failed to scan installed app", "error", err)
			continue
		}
		app.Backends = m.listBackendRefs(app.AppID)
		apps = append(apps, app)
	}

	return apps, nil
}

// GetInstalledApp returns a single installed app by instance ID
func (m *Manager) GetInstalledApp(ctx context.Context, instanceID string) (*InstalledApp, error) {
	row := m.db.QueryRow(`
		SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version
		FROM apps WHERE id = ?
	`, instanceID)

	app, err := scanInstalledApp(row)
	if err != nil {
		return nil, fmt.Errorf("app not found: %s", instanceID)
	}

	app.Backends = m.listBackendRefs(app.AppID)

	return app, nil
}

// UpdateApp updates an app to a newer version
func (m *Manager) UpdateApp(ctx context.Context, instanceID string) error {
	m.logger.Info("Updating app", "instance_id", instanceID)

	app, err := m.GetInstalledApp(ctx, instanceID)
	if err != nil {
		return err
	}

	// If app is pinned, we should only update if the catalog has exactly that version
	// but for now UpdateApp usually implies updating to whatever is in catalog.
	// We'll warn if updating a pinned app.
	if app.PinnedVersion != "" {
		m.logger.Warn("Updating a pinned app - this may change its version from the pin", "instance_id", instanceID, "pin", app.PinnedVersion)
	}

	oldVersion := app.Config["version"] // Version from current installation metadata
	if oldVersion == nil {
		oldVersion = ""
	}

	// Get new version from catalog
	catalogApp, err := m.catalog.GetApp(app.AppID)
	if err != nil {
		return fmt.Errorf("app not found in catalog: %w", err)
	}
	newVersion := catalogApp.Version

	// Record update start
	res, err := m.db.Exec(`
		INSERT INTO updates (app_id, status, old_version, new_version, started_at)
		VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
	`, instanceID, "pending", oldVersion, newVersion)
	var updateID int64
	if err == nil {
		updateID, _ = res.LastInsertId()
	}

	var backupID string
	// Check if backup is needed
	if catalogApp.Updates.BackupBeforeUpdate {
		m.logger.Info("Creating backup before update", "instance_id", instanceID)
		// We stop the app for backup to ensure consistency
		res, err := m.backupService.BackupApp(ctx, instanceID, storage.BackupOptions{
			StopBeforeBackup: true,
			Compress:         true,
			IncludeLogs:      false,
		})
		if err != nil {
			m.recordUpdateFailure(updateID, fmt.Errorf("backup failed: %w", err), false, "")
			return fmt.Errorf("backup failed: %w", err)
		}
		backupID = res.Backup.ID
		m.logger.Info("Backup created successfully", "backup_id", backupID)

		if updateID > 0 {
			m.db.Exec(`UPDATE updates SET backup_id = ? WHERE id = ?`, backupID, updateID)
		}
	}

	composePath := filepath.Join(m.appsDataDir, instanceID, "docker-compose.yml")

	// Pull new images
	if err := m.docker.ComposePull(ctx, composePath); err != nil {
		m.recordUpdateFailure(updateID, err, false, backupID)
		return fmt.Errorf("failed to pull images: %w", err)
	}

	// In-place update: docker compose up -d will recreate containers only if needed.
	// This provides near-zero downtime compared to Down then Up.
	if err := m.docker.ComposeUp(ctx, composePath); err != nil {
		// Attempt rollback if backup exists
		rolledBack := false
		if backupID != "" {
			m.logger.Warn("Update failed during recreation, attempting rollback", "error", err)
			if _, rErr := m.backupService.RestoreApp(ctx, backupID, storage.RestoreOptions{
				StopBeforeRestore:   true,
				RestartAfterRestore: true,
			}); rErr != nil {
				m.logger.Error("Rollback failed", "error", rErr)
			} else {
				rolledBack = true
			}
		}
		m.recordUpdateFailure(updateID, err, rolledBack, backupID)
		return fmt.Errorf("failed to recreate containers: %w", err)
	}

	// Verify health of the new version
	m.logger.Info("Verifying health after update", "instance_id", instanceID)
	
	isHealthy := m.waitForHealthy(ctx, instanceID, 60*time.Second)

	if !isHealthy {
		m.logger.Error("App unhealthy after update, initiating rollback", "instance_id", instanceID)
		rolledBack := false
		if backupID != "" {
			if _, rErr := m.backupService.RestoreApp(ctx, backupID, storage.RestoreOptions{
				StopBeforeRestore:   true,
				RestartAfterRestore: true,
			}); rErr != nil {
				m.logger.Error("Rollback failed after health check failure", "error", rErr)
			} else {
				rolledBack = true
			}
		}
		m.recordUpdateFailure(updateID, fmt.Errorf("app unhealthy after update"), rolledBack, backupID)
		return fmt.Errorf("app unhealthy after update (rollback attempted)")
	}

	// Record success
	if updateID > 0 {
		m.db.Exec(`
			UPDATE updates 
			SET status = 'success', completed_at = CURRENT_TIMESTAMP 
			WHERE id = ?
		`, updateID)
	}

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
	m.db.Exec(`
		UPDATE updates 
		SET status = ?, completed_at = CURRENT_TIMESTAMP, error = ?, rolled_back = ?, backup_id = ?
		WHERE id = ?
	`, status, err.Error(), rolledBack, backupID, updateID)
}

// UninstallApp removes an installed app
func (m *Manager) UninstallApp(ctx context.Context, instanceID string) error {
	if err := m.installer.Uninstall(ctx, instanceID); err != nil {
		return err
	}

	_, err := m.db.Exec(`DELETE FROM apps WHERE id = ?`, instanceID)
	return err
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
	defer rows.Close()

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

	var available []AvailableUpdate
	for _, app := range installedApps {
		catalogApp, err := m.catalog.GetApp(app.AppID)
		if err != nil {
			continue // Skip apps not in catalog (could be custom or removed)
		}

		currentVersion, _ := app.Config["version"].(string)
		latestVersion := catalogApp.Version

		// If app is pinned, it only has an "update" if the latest catalog version
		// is exactly the pinned version AND different from current.
		// Usually pinning means "stay on this version", so we skip update detection for pinned apps.
		isUpdate := false
		if app.PinnedVersion == "" {
			isUpdate = currentVersion != "" && currentVersion != latestVersion
		} else if app.PinnedVersion != currentVersion {
			// If it's pinned to something else than current, maybe we should report it?
			// For now, let's just say pinned apps don't get auto-updates.
			isUpdate = false
		}

		available = append(available, AvailableUpdate{
			InstanceID:     app.ID,
			AppID:          app.AppID,
			AppName:        app.Name,
			CurrentVersion: currentVersion,
			LatestVersion:  latestVersion,
			IsUpdate:       isUpdate,
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

// RefreshCatalog reloads the app catalog from disk
func (m *Manager) RefreshCatalog() error {
	return m.catalog.Refresh()
}

// Close cleans up manager resources
func (m *Manager) Close() error {
	// Cleanup any resources
	return nil
}

// updateStatus updates the status and updated_at fields for an app
func (m *Manager) updateStatus(ctx context.Context, instanceID string, status AppStatus) error {
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
	)

	if err := scanner.Scan(&id, &name, &appType, &source, &path, &status, &healthStatus, &installedAt, &updatedAt, &metadataJSON, &pinnedVersion); err != nil {
		return nil, err
	}

	config := make(map[string]interface{})
	if metadataJSON != "" {
		if err := json.Unmarshal([]byte(metadataJSON), &config); err != nil {
			slog.Warn("Failed to unmarshal app metadata", "id", id, "error", err)
		}
	}

	return &InstalledApp{
		ID:            id,
		AppID:         source,
		Name:          name,
		Type:          AppType(appType),
		Status:        AppStatus(status),
		HealthStatus:  HealthStatus(healthStatus),
		Path:          path,
		Config:        config,
		InstalledAt:   installedAt,
		UpdatedAt:     updatedAt,
		PinnedVersion: pinnedVersion.String,
	}, nil
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

// inferBackends attempts to derive reachable backend URLs for an installed app.
func (m *Manager) inferBackends(app *InstalledApp) []backendEntry {
	if app == nil {
		return nil
	}
	var backends []backendEntry
	if app.URL != "" {
		backends = append(backends, backendEntry{backend: app.URL})
	}
	if m.catalog != nil {
		if def, err := m.catalog.GetApp(app.AppID); err == nil {
			for _, p := range def.Deployment.Ports {
				if p.Host > 0 {
					backends = append(backends, backendEntry{
						backend: fmt.Sprintf("http://127.0.0.1:%d", p.Host),
						name:    p.Name,
					})
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
