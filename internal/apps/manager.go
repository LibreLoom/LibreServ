package apps

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
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
}

// NewManager creates a new app Manager
func NewManager(catalogPath, appsDataDir string, dockerClient *docker.Client, db *database.DB) (*Manager, error) {
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
	}

	// Create installer
	m.installer = NewInstaller(catalog, dockerClient, db, appsDataDir)

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
	return m.docker.ComposeUp(ctx, composePath)
}

// StopApp stops a running app
func (m *Manager) StopApp(ctx context.Context, instanceID string) error {
	m.logger.Info("Stopping app", "instance_id", instanceID)

	composePath := filepath.Join(m.appsDataDir, instanceID, "docker-compose.yml")
	return m.docker.ComposeStop(ctx, composePath)
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
	composePath := filepath.Join(m.appsDataDir, instanceID, "docker-compose.yml")

	// Check if compose file exists
	if _, err := os.Stat(composePath); os.IsNotExist(err) {
		return nil, fmt.Errorf("app not found: %s", instanceID)
	}

	// For now, return a basic status
	// TODO: Implement actual container status checking via docker compose ps

	return &AppStatusInfo{
		InstanceID: instanceID,
		Status:     StatusRunning,
		Containers: []ContainerStatus{},
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
	// TODO: Implement database query for installed apps
	return []*InstalledApp{}, nil
}

// GetInstalledApp returns a single installed app by instance ID
func (m *Manager) GetInstalledApp(ctx context.Context, instanceID string) (*InstalledApp, error) {
	// TODO: Implement database query
	return nil, fmt.Errorf("not implemented")
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

	return nil
}

// UninstallApp removes an installed app
func (m *Manager) UninstallApp(ctx context.Context, instanceID string) error {
	return m.installer.Uninstall(ctx, instanceID)
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
