package apps

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

// Manager handles the lifecycle of installed apps
type Manager struct {
	mu          sync.RWMutex
	catalog     *Catalog
	installer   *Installer
	docker      *docker.Client
	db          *database.DB
	appsDataDir string
	logger      *slog.Logger
	monitor     *monitoring.Monitor
}

// NewManager creates a new app Manager
func NewManager(catalogPath, appsDataDir string, dockerClient *docker.Client, db *database.DB, monitor *monitoring.Monitor) (*Manager, error) {
	// Load catalog
	catalog, err := NewCatalog(catalogPath)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize catalog: %w", err)
	}

	m := &Manager{
		catalog:     catalog,
		docker:      dockerClient,
		db:          db,
		appsDataDir: appsDataDir,
		logger:      slog.Default().With("component", "apps-manager"),
		monitor:     monitor,
	}

	// Create installer
	m.installer = NewInstaller(catalog, dockerClient, db, appsDataDir, monitor)

	return m, nil
}

// GetCatalog returns the app catalog
func (m *Manager) GetCatalog() *Catalog {
	return m.catalog
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
		SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata 
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
		apps = append(apps, app)
	}

	return apps, nil
}

// GetInstalledApp returns a single installed app by instance ID
func (m *Manager) GetInstalledApp(ctx context.Context, instanceID string) (*InstalledApp, error) {
	row := m.db.QueryRow(`
		SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata 
		FROM apps WHERE id = ?
	`, instanceID)

	app, err := scanInstalledApp(row)
	if err != nil {
		return nil, fmt.Errorf("app not found: %s", instanceID)
	}

	return app, nil
}

// UpdateApp updates an app to a newer version
func (m *Manager) UpdateApp(ctx context.Context, instanceID string) error {
	m.logger.Info("Updating app", "instance_id", instanceID)

	composePath := filepath.Join(m.appsDataDir, instanceID, "docker-compose.yml")

	// Pull new images
	if err := m.docker.ComposePull(ctx, composePath); err != nil {
		return fmt.Errorf("failed to pull images: %w", err)
	}

	// Restart with new images
	if err := m.docker.ComposeDown(ctx, composePath); err != nil {
		return fmt.Errorf("failed to stop containers: %w", err)
	}

	if err := m.docker.ComposeUp(ctx, composePath); err != nil {
		return fmt.Errorf("failed to start containers: %w", err)
	}

	return m.updateStatus(ctx, instanceID, StatusRunning)
}

// UninstallApp removes an installed app
func (m *Manager) UninstallApp(ctx context.Context, instanceID string) error {
	if err := m.installer.Uninstall(ctx, instanceID); err != nil {
		return err
	}

	_, err := m.db.Exec(`DELETE FROM apps WHERE id = ?`, instanceID)
	return err
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
	)

	if err := scanner.Scan(&id, &name, &appType, &source, &path, &status, &healthStatus, &installedAt, &updatedAt, &metadataJSON); err != nil {
		return nil, err
	}

	config := make(map[string]interface{})
	if metadataJSON != "" {
		_ = json.Unmarshal([]byte(metadataJSON), &config)
	}

	return &InstalledApp{
		ID:           id,
		AppID:        source,
		Name:         name,
		Type:         AppType(appType),
		Status:       AppStatus(status),
		HealthStatus: HealthStatus(healthStatus),
		Path:         path,
		Config:       config,
		InstalledAt:  installedAt,
		UpdatedAt:    updatedAt,
	}, nil
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
