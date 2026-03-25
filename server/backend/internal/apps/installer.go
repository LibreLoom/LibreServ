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
	"regexp"
	"strconv"
	"strings"
	"text/template"
	"time"

	"gopkg.in/yaml.v3"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

// Installer handles app installation and configuration
type Installer struct {
	catalog         *Catalog
	runtime         runtime.ContainerRuntime
	db              *database.DB
	appsDataDir     string
	catalogPath     string
	logger          *slog.Logger
	monitor         *monitoring.Monitor
	metricsCache    *AppMetricsCache
	portManager     *PortManager
	registerBackend func(appID, backend, name string)
}

// NewInstaller creates a new Installer
func NewInstaller(catalog *Catalog, runtime runtime.ContainerRuntime, db *database.DB, appsDataDir string, monitor *monitoring.Monitor, metricsCache *AppMetricsCache, portManager *PortManager) *Installer {
	return &Installer{
		catalog:      catalog,
		runtime:      runtime,
		db:           db,
		appsDataDir:  appsDataDir,
		logger:       slog.Default().With("component", "installer"),
		monitor:      monitor,
		metricsCache: metricsCache,
		portManager:  portManager,
	}
}

// SetCatalogPath sets the catalog path for the installer
func (i *Installer) SetCatalogPath(catalogPath string) {
	i.catalogPath = catalogPath
}

// SetBackendRegistrar wires a callback used to register the reachable backend for an app (for ACME).
func (i *Installer) SetBackendRegistrar(fn func(appID, backend, name string)) {
	i.registerBackend = fn
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

// Install installs an app from the catalog (async - returns immediately with installing status)
func (i *Installer) Install(ctx context.Context, opts InstallOptions) (*InstallResult, error) {
	i.logger.Info("Installing app", "app_id", opts.AppID)

	appDef, err := i.catalog.GetApp(opts.AppID)
	if err != nil {
		return &InstallResult{Success: false, Error: err.Error()}, err
	}

	instanceID := generateInstanceID()

	appName := opts.Name
	if appName == "" {
		appName = appDef.Name
	}

	installPath := filepath.Join(i.appsDataDir, instanceID)
	if err := os.MkdirAll(installPath, 0755); err != nil {
		return &InstallResult{Success: false, Error: "failed to create install directory"}, err
	}

	config := i.mergeConfig(appDef, opts.Config)

	config["instance_id"] = instanceID
	config["install_path"] = installPath
	config["app_name"] = appName

	config = i.generateAutoValues(appDef, config)

	// Auto-allocate ports for port-type config fields
	if i.portManager != nil {
		for _, field := range appDef.Configuration {
			if field.Type != "port" {
				continue
			}

			current := toInt(config[field.Name])

			// If user explicitly set this field to a non-default value, check availability
			userSet := opts.Config != nil
			if userSet {
				_, userSet = opts.Config[field.Name]
			}
			// If the value matches the field's default, treat as auto (not explicitly chosen)
			if userSet {
				defaultVal := toInt(field.Default)
				if defaultVal > 0 && current == defaultVal {
					userSet = false
				}
			}
			if userSet {
				if current > 0 && !i.portManager.IsAvailable(current) {
					_ = os.RemoveAll(installPath)
					return &InstallResult{
						Success: false,
						Error:   fmt.Sprintf("port %d is already in use", current),
					}, fmt.Errorf("port %d is already in use", current)
				}
			} else {
				// User didn't set it — auto-allocate
				preferred := current
				if preferred == 0 {
					preferred = toInt(field.Default)
				}
				if preferred == 0 {
					preferred = WellKnownPortMax + 1 // fallback to 1024
				}

				allocated, err := i.portManager.Allocate(preferred)
				if err != nil {
					_ = os.RemoveAll(installPath)
					return &InstallResult{Success: false, Error: "no available ports"}, err
				}
				config[field.Name] = allocated
			}
		}

		// Reserve all allocated ports in the port manager
		for _, field := range appDef.Configuration {
			if field.Type != "port" {
				continue
			}
			if p := toInt(config[field.Name]); p > 0 {
				i.portManager.Reserve(p, instanceID)
			}
		}
	}

	composePath, err := i.processComposeTemplate(appDef, installPath, config)
	if err != nil {
		_ = os.RemoveAll(installPath)
		return &InstallResult{Success: false, Error: "failed to process compose template"}, err
	}

	if err := i.createMetadataFile(installPath, appDef, config); err != nil {
		_ = os.RemoveAll(installPath)
		return &InstallResult{Success: false, Error: "failed to create metadata file"}, err
	}

	if err := i.createDataDirectories(installPath, appDef); err != nil {
		_ = os.RemoveAll(installPath)
		return &InstallResult{Success: false, Error: "failed to create data directories"}, err
	}

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

	if len(appDef.Deployment.Ports) > 0 {
		port := appDef.Deployment.Ports[0].Host
		// Check if user overrode the port in config
		for _, field := range appDef.Configuration {
			if field.Type == "port" {
				if configPort, ok := config[field.Name]; ok {
					switch v := configPort.(type) {
					case float64:
						port = int(v)
					case int:
						port = v
					case string:
						if parsed, err := strconv.Atoi(v); err == nil {
							port = parsed
						}
					}
					break
				}
			}
		}
		installedApp.URL = fmt.Sprintf("http://localhost:%d", port)
	}

	if err := i.saveInstalledApp(installedApp); err != nil {
		_ = os.RemoveAll(installPath)
		return &InstallResult{Success: false, Error: "failed to save app record"}, err
	}

	go i.completeInstall(appDef, installedApp, composePath, config)

	return &InstallResult{
		Success: true,
		App:     installedApp,
	}, nil
}

func (i *Installer) completeInstall(appDef *AppDefinition, installedApp *InstalledApp, composePath string, config map[string]interface{}) {
	instanceID := installedApp.ID
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	i.logger.Info("Pulling images", "app_id", appDef.ID, "instance_id", instanceID)
	if err := i.runtime.ComposePull(ctx, composePath); err != nil {
		i.logger.Error("Failed to pull images", "error", err)
	}

	i.logger.Info("Starting containers", "app_id", appDef.ID, "instance_id", instanceID)
	if err := i.runtime.ComposeUp(ctx, composePath); err != nil {
		i.logger.Error("Failed to start containers", "error", err)
		i.handleInstallFailure(instanceID, installedApp.Path, "failed to start containers: "+err.Error())
		return
	}

	if err := i.waitForContainers(ctx, instanceID); err != nil {
		i.logger.Error("Containers failed to start", "error", err)
		i.handleInstallFailure(instanceID, installedApp.Path, "containers failed to start: "+err.Error())
		return
	}

	installedApp.Status = StatusRunning
	installedApp.HealthStatus = HealthUnknown

	if i.metricsCache != nil {
		i.metricsCache.UpdateStatus(instanceID, StatusRunning)
	}

	if i.registerBackend != nil && installedApp.URL != "" {
		i.registerBackend(appDef.ID, installedApp.URL, "")
	}
	if i.registerBackend != nil {
		for _, p := range appDef.Deployment.Ports {
			if p.Host == 0 || p.Name == "" {
				continue
			}
			i.registerBackend(appDef.ID, fmt.Sprintf("http://localhost:%d", p.Host), p.Name)
		}
		for _, b := range appDef.Deployment.Backends {
			if b.URL == "" || b.Name == "" {
				continue
			}
			i.registerBackend(appDef.ID, b.URL, b.Name)
		}
	}

	if err := i.saveInstalledApp(installedApp); err != nil {
		i.logger.Error("Failed to update installed app", "error", err)
	}

	if i.monitor != nil {
		if err := i.registerHealth(appDef, instanceID, config); err != nil {
			i.logger.Warn("Failed to register health check", "error", err)
		}
	}

	if err := i.RunSystemSetup(ctx, appDef, instanceID, config); err != nil {
		i.logger.Warn("system-setup failed", "error", err)
	}

	i.logger.Info("App installed successfully", "app_id", appDef.ID, "instance_id", instanceID)
}

func (i *Installer) updateAppStatus(instanceID string, status AppStatus, errMsg string) error {
	// Use COALESCE to preserve existing error if not provided
	if errMsg != "" {
		_, err := i.db.Exec(`UPDATE apps SET status = ?, updated_at = ?, error = ? WHERE id = ?`, string(status), time.Now(), errMsg, instanceID)
		return err
	}
	// If no error message, clear the error field
	_, err := i.db.Exec(`UPDATE apps SET status = ?, updated_at = ?, error = NULL WHERE id = ?`, string(status), time.Now(), instanceID)
	return err
}

// handleInstallFailure cleans up after a failed install
func (i *Installer) handleInstallFailure(instanceID, installPath, errMsg string) {
	// Mark as error in DB
	i.updateAppStatus(instanceID, StatusError, errMsg)

	// Try to stop and remove any running containers
	if i.runtime != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		composePath := filepath.Join(installPath, "docker-compose.yml")
		if _, err := os.Stat(composePath); err == nil {
			// Try to clean up docker resources
			_ = i.runtime.ComposeDown(ctx, composePath)
		}
	}

	// Remove the installation directory
	_ = os.RemoveAll(installPath)

	// Remove from DB entirely (cascade will handle related records)
	_, _ = i.db.Exec(`DELETE FROM apps WHERE id = ?`, instanceID)

	i.logger.Info("Install failed and cleaned up", "instance_id", instanceID, "error", errMsg)
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
			path := filepath.Join(installPath, "data")
			if abs, err := filepath.Abs(path); err == nil {
				return abs
			}
			return path
		},
		"configPath": func() string {
			path := filepath.Join(installPath, "config")
			if abs, err := filepath.Abs(path); err == nil {
				return abs
			}
			return path
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
	// Ensure version is in config for DB persistence
	config["version"] = appDef.Version

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
	dirs := []string{"data", "config", "logs"}

	for _, dir := range dirs {
		path := filepath.Join(installPath, dir)
		if err := os.MkdirAll(path, 0755); err != nil {
			return err
		}
	}

	for _, vol := range appDef.Deployment.Volumes {
		if vol.Name == "" || vol.Name == "data" || vol.Name == "config" || vol.Name == "logs" {
			continue
		}
		dataPath := filepath.Join(installPath, "data", vol.Name)
		if err := os.MkdirAll(dataPath, 0755); err != nil {
			return err
		}
		configPath := filepath.Join(installPath, "config", vol.Name)
		if err := os.MkdirAll(configPath, 0755); err != nil {
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

	if _, err := os.Stat(composePath); err == nil {
		if err := i.runtime.ComposeDown(ctx, composePath); err != nil {
			i.logger.Warn("Failed to stop containers", "error", err)
		}
	} else {
		i.logger.Debug("Compose file not found, skipping container stop", "path", composePath)
	}

	if _, err := os.Stat(installPath); err == nil {
		if err := os.RemoveAll(installPath); err != nil {
			i.logger.Warn("Failed to remove installation directory", "error", err)
		}
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

		if exists {
			if err := validateField(field, value); err != nil {
				return fmt.Errorf("field %s: %w", field.Name, err)
			}
		}
	}

	return nil
}

func validateField(field ConfigField, value interface{}) error {
	switch field.Type {
	case "string", "password":
		if _, ok := value.(string); !ok {
			return fmt.Errorf("must be a string")
		}
	case "number":
		switch value.(type) {
		case int, int64, float64, float32:
		default:
			return fmt.Errorf("must be a number")
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("must be a boolean")
		}
	case "select":
		str, ok := value.(string)
		if !ok {
			return fmt.Errorf("must be a string option")
		}
		if len(field.Options) > 0 {
			found := false
			for _, opt := range field.Options {
				if opt == str {
					found = true
					break
				}
			}
			if !found {
				return fmt.Errorf("must be one of %v", field.Options)
			}
		}
	case "port":
		var port int
		switch v := value.(type) {
		case float64:
			port = int(v)
		case int:
			port = v
		case string:
			// best-effort parse
			if pv, err := strconv.Atoi(v); err == nil {
				port = pv
			} else {
				return fmt.Errorf("invalid port")
			}
		default:
			return fmt.Errorf("invalid port")
		}
		if port <= 0 || port > 65535 {
			return fmt.Errorf("port out of range")
		}
	}
	if field.Validation != "" {
		str, ok := value.(string)
		if !ok {
			return fmt.Errorf("validation requires string")
		}
		re, err := regexp.Compile(field.Validation)
		if err != nil {
			return fmt.Errorf("invalid validation regex")
		}
		if !re.MatchString(str) {
			return fmt.Errorf("value does not match required pattern")
		}
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
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			type = excluded.type,
			source = excluded.source,
			path = excluded.path,
			status = excluded.status,
			health_status = excluded.health_status,
			updated_at = excluded.updated_at,
			metadata = excluded.metadata
	`, app.ID, app.Name, string(app.Type), app.AppID, app.Path, string(app.Status), string(app.HealthStatus), app.InstalledAt, app.UpdatedAt, string(configJSON))

	return err
}

func generateInstanceID() string {
	bytes := make([]byte, 8)
	_, _ = rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func generateSecurePassword(length int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*"
	bytes := make([]byte, length)
	_, _ = rand.Read(bytes)
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

func (i *Installer) RunSystemSetup(ctx context.Context, appDef *AppDefinition, instanceID string, config map[string]interface{}) error {
	setupScript := appDef.Scripts.System.Setup
	if setupScript == "" {
		return nil
	}

	scriptPath := filepath.Join(appDef.CatalogPath, setupScript)
	if _, err := os.Stat(scriptPath); os.IsNotExist(err) {
		i.logger.Debug("system-setup script not found, skipping", "script", setupScript)
		return nil
	}

	i.logger.Info("Running system-setup", "app_id", appDef.ID, "instance_id", instanceID)

	executor := NewScriptExecutorWithCatalog(i.logger, nil, i.appsDataDir, i.catalogPath)
	result, err := executor.Execute(ctx, instanceID, scriptPath, config)
	if err != nil {
		i.logger.Warn("system-setup failed", "app_id", appDef.ID, "error", err)
		return nil
	}

	if !result.Success {
		i.logger.Warn("system-setup returned non-zero exit code", "app_id", appDef.ID, "exit_code", result.ExitCode)
	} else {
		i.logger.Info("system-setup completed successfully", "app_id", appDef.ID)
	}

	return nil
}

func (i *Installer) waitForContainers(ctx context.Context, instanceID string) error {
	label := "libreserv.app=" + instanceID
	maxWait := 5 * time.Minute
	interval := 2 * time.Second
	start := time.Now()

	for {
		containers, err := i.runtime.ListContainersByLabel(label)
		if err != nil {
			return fmt.Errorf("failed to list containers: %w", err)
		}

		if len(containers) == 0 {
			if time.Since(start) > maxWait {
				return fmt.Errorf("no containers found after %v", maxWait)
			}
			i.logger.Debug("No containers yet, waiting...", "instance_id", instanceID)
			time.Sleep(interval)
			continue
		}

		running := 0
		for _, c := range containers {
			if c.State == "running" {
				running++
			}
		}

		if running == len(containers) {
			i.logger.Debug("All containers running", "instance_id", instanceID, "count", running)
			return nil
		}

		if time.Since(start) > maxWait {
			return fmt.Errorf("timeout waiting for containers to start: %d/%d running", running, len(containers))
		}

		i.logger.Debug("Waiting for containers to start", "instance_id", instanceID, "running", running, "total", len(containers))
		time.Sleep(interval)
	}
}
