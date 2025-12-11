package apps

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"text/template"
	"time"

	"gopkg.in/yaml.v3"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

// Installer handles app installation and configuration
type Installer struct {
	catalog     *Catalog
	docker      *docker.Client
	db          *database.DB
	appsDataDir string
	logger      *slog.Logger
	monitor     *monitoring.Monitor
}

// NewInstaller creates a new Installer
func NewInstaller(catalog *Catalog, dockerClient *docker.Client, db *database.DB, appsDataDir string, monitor *monitoring.Monitor) *Installer {
	return &Installer{
		catalog:     catalog,
		docker:      dockerClient,
		db:          db,
		appsDataDir: appsDataDir,
		logger:      slog.Default().With("component", "installer"),
		monitor:     monitor,
	}
}

// InstallOptions contains options for app installation
type InstallOptions struct {
	AppID  string                 `json:"app_id"`
	Config map[string]interface{} `json:"config"`
	Name   string                 `json:"name"` // Optional custom name
}

// InstallResult contains the result of an installation
type InstallResult struct {
	Success bool          `json:"success"`
	App     *InstalledApp `json:"app,omitempty"`
	Error   string        `json:"error,omitempty"`
}

// Install installs an app from the catalog
func (i *Installer) Install(ctx context.Context, opts InstallOptions) (*InstallResult, error) {
	i.logger.Info("Installing app", "app_id", opts.AppID)

	// Get app definition from catalog
	appDef, err := i.catalog.GetApp(opts.AppID)
	if err != nil {
		return &InstallResult{Success: false, Error: err.Error()}, err
	}

	// Generate unique instance ID
	instanceID := generateInstanceID()

	// Determine app name
	appName := opts.Name
	if appName == "" {
		appName = appDef.Name
	}

	// Create installation directory
	installPath := filepath.Join(i.appsDataDir, instanceID)
	if err := os.MkdirAll(installPath, 0755); err != nil {
		return &InstallResult{Success: false, Error: "failed to create install directory"}, err
	}

	// Merge default config with user config
	config := i.mergeConfig(appDef, opts.Config)

	// Add generated values
	config["instance_id"] = instanceID
	config["install_path"] = installPath
	config["app_name"] = appName

	// Generate any auto-generated values (passwords, etc.)
	config = i.generateAutoValues(appDef, config)

	// Process compose template
	composePath, err := i.processComposeTemplate(appDef, installPath, config)
	if err != nil {
		os.RemoveAll(installPath)
		return &InstallResult{Success: false, Error: "failed to process compose template"}, err
	}

	// Create .libreserv.yaml metadata file
	if err := i.createMetadataFile(installPath, appDef, config); err != nil {
		os.RemoveAll(installPath)
		return &InstallResult{Success: false, Error: "failed to create metadata file"}, err
	}

	// Create any required data directories
	if err := i.createDataDirectories(installPath, appDef); err != nil {
		os.RemoveAll(installPath)
		return &InstallResult{Success: false, Error: "failed to create data directories"}, err
	}

	// Create installed app record
	installedApp := &InstalledApp{
		ID:           instanceID,
		AppID:        appDef.ID,
		Name:         appName,
		Type:         appDef.Type,
		Status:       StatusInstalling,
		HealthStatus: HealthUnknown,
		Path:         installPath,
		Config:       config,
		InstalledAt:  time.Now(),
		UpdatedAt:    time.Now(),
	}

	// Pull images
	i.logger.Info("Pulling images", "app_id", opts.AppID, "instance_id", instanceID)
	if err := i.docker.ComposePull(ctx, composePath); err != nil {
		i.logger.Error("Failed to pull images", "error", err)
		// Don't fail on pull error, images might already exist
	}

	// Start containers
	i.logger.Info("Starting containers", "app_id", opts.AppID, "instance_id", instanceID)
	if err := i.docker.ComposeUp(ctx, composePath); err != nil {
		os.RemoveAll(installPath)
		return &InstallResult{Success: false, Error: "failed to start containers"}, err
	}

	// Update status to running
	installedApp.Status = StatusRunning
	installedApp.HealthStatus = HealthUnknown

	// Determine URL if app exposes a web interface
	if len(appDef.Deployment.Ports) > 0 {
		port := appDef.Deployment.Ports[0].Host
		installedApp.URL = fmt.Sprintf("http://localhost:%d", port)
	}

	// Persist installed app
	if err := i.saveInstalledApp(installedApp); err != nil {
		i.logger.Error("Failed to save installed app", "error", err)
	}

	// Register default health checks if configured
	if i.monitor != nil {
		if err := i.registerHealth(appDef, instanceID, config); err != nil {
			i.logger.Warn("Failed to register health check", "error", err)
		}
	}

	i.logger.Info("App installed successfully", "app_id", opts.AppID, "instance_id", instanceID)

	return &InstallResult{
		Success: true,
		App:     installedApp,
	}, nil
}

// mergeConfig merges default values from app definition with user-provided config
func (i *Installer) mergeConfig(appDef *AppDefinition, userConfig map[string]interface{}) map[string]interface{} {
	config := make(map[string]interface{})

	// First, set defaults from app definition
	for _, field := range appDef.Configuration {
		if field.Default != nil {
			config[field.Name] = field.Default
		}
	}

	// Apply environment variable defaults
	for key, value := range appDef.Deployment.Environment {
		config[key] = value
	}

	// Override with user config
	for key, value := range userConfig {
		config[key] = value
	}

	return config
}

// generateAutoValues generates automatic values like passwords
func (i *Installer) generateAutoValues(appDef *AppDefinition, config map[string]interface{}) map[string]interface{} {
	for _, field := range appDef.Configuration {
		// Skip if already set
		if _, exists := config[field.Name]; exists {
			continue
		}

		// Generate password for password fields without default
		if field.Type == "password" {
			config[field.Name] = generateSecurePassword(24)
		}
	}

	return config
}

// processComposeTemplate processes the compose template with configuration
func (i *Installer) processComposeTemplate(appDef *AppDefinition, installPath string, config map[string]interface{}) (string, error) {
	// Get source compose file path
	srcPath, err := i.catalog.GetComposeFilePath(appDef.ID)
	if err != nil {
		return "", err
	}

	// Read template
	templateData, err := os.ReadFile(srcPath)
	if err != nil {
		return "", fmt.Errorf("failed to read compose template: %w", err)
	}

	// Create template with helper functions
	funcMap := template.FuncMap{
		"generatePassword": func(length int) string {
			return generateSecurePassword(length)
		},
		"dataPath": func() string {
			return filepath.Join(installPath, "data")
		},
		"configPath": func() string {
			return filepath.Join(installPath, "config")
		},
		"default": func(def, val interface{}) interface{} {
			if val == nil || val == "" {
				return def
			}
			return val
		},
	}

	tmpl, err := template.New("compose").Funcs(funcMap).Parse(string(templateData))
	if err != nil {
		return "", fmt.Errorf("failed to parse compose template: %w", err)
	}

	// Execute template
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, config); err != nil {
		return "", fmt.Errorf("failed to execute compose template: %w", err)
	}

	// Write processed compose file
	destPath := filepath.Join(installPath, "docker-compose.yml")
	if err := os.WriteFile(destPath, buf.Bytes(), 0644); err != nil {
		return "", fmt.Errorf("failed to write compose file: %w", err)
	}

	return destPath, nil
}

// createMetadataFile creates the .libreserv.yaml metadata file
func (i *Installer) createMetadataFile(installPath string, appDef *AppDefinition, config map[string]interface{}) error {
	metadata := map[string]interface{}{
		"app_id":       appDef.ID,
		"app_name":     appDef.Name,
		"app_version":  appDef.Version,
		"installed_at": time.Now().Format(time.RFC3339),
		"config":       config,
		"type":         string(appDef.Type),
	}

	data, err := yaml.Marshal(metadata)
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(installPath, ".libreserv.yaml"), data, 0600)
}

// createDataDirectories creates required data directories for the app
func (i *Installer) createDataDirectories(installPath string, appDef *AppDefinition) error {
	// Create standard directories
	dirs := []string{"data", "config", "logs"}

	for _, dir := range dirs {
		path := filepath.Join(installPath, dir)
		if err := os.MkdirAll(path, 0755); err != nil {
			return err
		}
	}

	return nil
}

// Uninstall removes an installed app
func (i *Installer) Uninstall(ctx context.Context, instanceID string) error {
	i.logger.Info("Uninstalling app", "instance_id", instanceID)

	installPath := filepath.Join(i.appsDataDir, instanceID)
	composePath := filepath.Join(installPath, "docker-compose.yml")

	// Stop and remove containers
	if err := i.docker.ComposeDown(ctx, composePath); err != nil {
		i.logger.Warn("Failed to stop containers", "error", err)
		// Continue with removal anyway
	}

	// Remove installation directory
	if err := os.RemoveAll(installPath); err != nil {
		return fmt.Errorf("failed to remove installation directory: %w", err)
	}

	i.logger.Info("App uninstalled successfully", "instance_id", instanceID)
	return nil
}

// ValidateConfig validates user configuration against app definition
func (i *Installer) ValidateConfig(appID string, config map[string]interface{}) error {
	appDef, err := i.catalog.GetApp(appID)
	if err != nil {
		return err
	}

	for _, field := range appDef.Configuration {
		value, exists := config[field.Name]

		// Check required fields
		if field.Required && (!exists || value == nil || value == "") {
			return fmt.Errorf("required field '%s' is missing", field.Label)
		}

		// TODO: Add type validation, regex validation, etc.
	}

	return nil
}

// Helper functions

// saveInstalledApp stores an installed app record in the database
func (i *Installer) saveInstalledApp(app *InstalledApp) error {
	configJSON, err := json.Marshal(app.Config)
	if err != nil {
		return fmt.Errorf("failed to marshal app config: %w", err)
	}

	_, err = i.db.Exec(`
		INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, app.ID, app.Name, string(app.Type), app.AppID, app.Path, string(app.Status), string(app.HealthStatus), app.InstalledAt, app.UpdatedAt, string(configJSON))

	return err
}

func generateInstanceID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func generateSecurePassword(length int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*"
	bytes := make([]byte, length)
	rand.Read(bytes)
	for i, b := range bytes {
		bytes[i] = chars[int(b)%len(chars)]
	}
	return string(bytes)
}

// registerHealth converts app definition health config to monitoring config and registers it
func (i *Installer) registerHealth(appDef *AppDefinition, instanceID string, cfg map[string]interface{}) error {
	hc := appDef.HealthCheck
	if hc.Type == "" {
		return nil
	}

	const (
		defaultInterval = 30 * time.Second
		defaultTimeout  = 10 * time.Second
	)

	mcfg := monitoring.HealthCheckConfig{
		Interval:         hc.Interval,
		Timeout:          hc.Timeout,
		FailureThreshold: hc.Retries,
		SuccessThreshold: 1,
	}
	if mcfg.Interval == 0 {
		mcfg.Interval = defaultInterval
	}
	if mcfg.Timeout == 0 {
		mcfg.Timeout = defaultTimeout
	}
	if mcfg.FailureThreshold == 0 {
		mcfg.FailureThreshold = 3
	}

	switch strings.ToLower(hc.Type) {
	case "http":
		port := hc.Port
		if port == 0 && len(appDef.Deployment.Ports) > 0 {
			port = appDef.Deployment.Ports[0].Host
		}
		if port == 0 {
			return fmt.Errorf("no port available for http health check")
		}
		endpoint := hc.Endpoint
		if endpoint == "" {
			endpoint = "/"
		}
		mcfg.HTTP = &monitoring.HTTPCheckConfig{
			URL:            fmt.Sprintf("http://localhost:%d%s", port, endpoint),
			Method:         "GET",
			ExpectedStatus: 200,
		}
	case "tcp":
		host := "localhost"
		port := hc.Port
		if port == 0 && len(appDef.Deployment.Ports) > 0 {
			port = appDef.Deployment.Ports[0].Host
		}
		if port == 0 {
			return fmt.Errorf("no port available for tcp health check")
		}
		mcfg.TCP = &monitoring.TCPCheckConfig{Host: host, Port: port}
	case "container":
		mcfg.Container = &monitoring.ContainerCheckConfig{ContainerName: instanceID}
	default:
		return nil
	}

	return i.monitor.RegisterApp(instanceID, mcfg)
}
