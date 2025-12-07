package network

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"text/template"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// CaddyManager manages Caddy reverse proxy configuration
type CaddyManager struct {
	db           *database.DB
	config       CaddyConfig
	routes       map[string]*Route
	routesMu     sync.RWMutex
	httpClient   *http.Client
	configBackup string
}

// NewCaddyManager creates a new Caddy manager
func NewCaddyManager(db *database.DB, config CaddyConfig) *CaddyManager {
	return &CaddyManager{
		db:     db,
		config: config,
		routes: make(map[string]*Route),
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// Initialize loads existing routes and validates Caddy configuration
func (cm *CaddyManager) Initialize(ctx context.Context) error {
	// Load routes from database
	if err := cm.loadRoutes(ctx); err != nil {
		return fmt.Errorf("failed to load routes: %w", err)
	}

	// Generate initial Caddyfile
	if err := cm.regenerateCaddyfile(); err != nil {
		return fmt.Errorf("failed to generate Caddyfile: %w", err)
	}

	return nil
}

// AddRoute adds a new route for an app
func (cm *CaddyManager) AddRoute(ctx context.Context, subdomain, backend, appID string) (*Route, error) {
	cm.routesMu.Lock()
	defer cm.routesMu.Unlock()

	// Check if route already exists
	fullDomain := subdomain + "." + cm.config.DefaultDomain
	for _, r := range cm.routes {
		if r.FullDomain() == fullDomain {
			return nil, fmt.Errorf("route for %s already exists", fullDomain)
		}
	}

	// Backup current config
	cm.backupCurrentConfig()

	// Create new route
	route := &Route{
		ID:        uuid.New().String(),
		Subdomain: subdomain,
		Domain:    cm.config.DefaultDomain,
		Backend:   backend,
		AppID:     appID,
		SSL:       cm.config.AutoHTTPS,
		Enabled:   true,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	// Validate the new configuration
	cm.routes[route.ID] = route
	if err := cm.validateConfig(); err != nil {
		delete(cm.routes, route.ID)
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	// Save to database
	if err := cm.saveRoute(ctx, route); err != nil {
		delete(cm.routes, route.ID)
		return nil, fmt.Errorf("failed to save route: %w", err)
	}

	// Apply the new configuration
	if err := cm.regenerateCaddyfile(); err != nil {
		// Rollback
		delete(cm.routes, route.ID)
		cm.deleteRoute(ctx, route.ID)
		cm.restoreBackup()
		return nil, fmt.Errorf("failed to apply configuration: %w", err)
	}

	// Reload Caddy
	if err := cm.reloadCaddy(); err != nil {
		// Rollback
		delete(cm.routes, route.ID)
		cm.deleteRoute(ctx, route.ID)
		cm.restoreBackup()
		return nil, fmt.Errorf("failed to reload Caddy: %w", err)
	}

	log.Printf("Route added: %s -> %s", route.FullDomain(), route.Backend)
	return route, nil
}

// RemoveRoute removes a route
func (cm *CaddyManager) RemoveRoute(ctx context.Context, routeID string) error {
	cm.routesMu.Lock()
	defer cm.routesMu.Unlock()

	route, ok := cm.routes[routeID]
	if !ok {
		return fmt.Errorf("route not found: %s", routeID)
	}

	// Backup current config
	cm.backupCurrentConfig()

	// Remove from memory
	delete(cm.routes, routeID)

	// Regenerate Caddyfile
	if err := cm.regenerateCaddyfile(); err != nil {
		cm.routes[routeID] = route
		return fmt.Errorf("failed to regenerate configuration: %w", err)
	}

	// Reload Caddy
	if err := cm.reloadCaddy(); err != nil {
		cm.routes[routeID] = route
		cm.restoreBackup()
		return fmt.Errorf("failed to reload Caddy: %w", err)
	}

	// Delete from database
	if err := cm.deleteRoute(ctx, routeID); err != nil {
		log.Printf("Warning: failed to delete route from database: %v", err)
	}

	log.Printf("Route removed: %s", route.FullDomain())
	return nil
}

// UpdateRoute updates an existing route
func (cm *CaddyManager) UpdateRoute(ctx context.Context, routeID string, backend string, enabled bool) (*Route, error) {
	cm.routesMu.Lock()
	defer cm.routesMu.Unlock()

	route, ok := cm.routes[routeID]
	if !ok {
		return nil, fmt.Errorf("route not found: %s", routeID)
	}

	// Backup current config
	cm.backupCurrentConfig()

	// Update route
	oldBackend := route.Backend
	oldEnabled := route.Enabled
	route.Backend = backend
	route.Enabled = enabled
	route.UpdatedAt = time.Now()

	// Regenerate and reload
	if err := cm.regenerateCaddyfile(); err != nil {
		route.Backend = oldBackend
		route.Enabled = oldEnabled
		return nil, fmt.Errorf("failed to regenerate configuration: %w", err)
	}

	if err := cm.reloadCaddy(); err != nil {
		route.Backend = oldBackend
		route.Enabled = oldEnabled
		cm.restoreBackup()
		return nil, fmt.Errorf("failed to reload Caddy: %w", err)
	}

	// Update in database
	if err := cm.updateRouteInDB(ctx, route); err != nil {
		log.Printf("Warning: failed to update route in database: %v", err)
	}

	return route, nil
}

// GetRoute returns a specific route
func (cm *CaddyManager) GetRoute(routeID string) (*Route, error) {
	cm.routesMu.RLock()
	defer cm.routesMu.RUnlock()

	route, ok := cm.routes[routeID]
	if !ok {
		return nil, fmt.Errorf("route not found: %s", routeID)
	}
	return route, nil
}

// GetRouteByApp returns the route for a specific app
func (cm *CaddyManager) GetRouteByApp(appID string) (*Route, error) {
	cm.routesMu.RLock()
	defer cm.routesMu.RUnlock()

	for _, route := range cm.routes {
		if route.AppID == appID {
			return route, nil
		}
	}
	return nil, fmt.Errorf("no route found for app: %s", appID)
}

// ListRoutes returns all routes
func (cm *CaddyManager) ListRoutes() []*Route {
	cm.routesMu.RLock()
	defer cm.routesMu.RUnlock()

	routes := make([]*Route, 0, len(cm.routes))
	for _, route := range cm.routes {
		routes = append(routes, route)
	}
	return routes
}

// GetStatus returns the current Caddy status
func (cm *CaddyManager) GetStatus(ctx context.Context) (*CaddyStatus, error) {
	status := &CaddyStatus{
		Routes: len(cm.routes),
	}

	// Try to ping Caddy admin API
	if cm.config.AdminAPI != "" {
		resp, err := cm.httpClient.Get(cm.config.AdminAPI + "/config/")
		if err != nil {
			status.Running = false
			status.Error = err.Error()
		} else {
			resp.Body.Close()
			status.Running = resp.StatusCode == 200
		}
	} else {
		// Check if caddy process is running
		cmd := exec.Command("pgrep", "-x", "caddy")
		if err := cmd.Run(); err == nil {
			status.Running = true
		}
	}

	// Get configured domains
	cm.routesMu.RLock()
	for _, route := range cm.routes {
		if route.Enabled {
			status.Domains = append(status.Domains, route.FullDomain())
		}
	}
	cm.routesMu.RUnlock()

	// Validate config
	status.ConfigValid = cm.validateConfig() == nil

	return status, nil
}

// regenerateCaddyfile generates and writes the Caddyfile
func (cm *CaddyManager) regenerateCaddyfile() error {
	content, err := cm.generateCaddyfile()
	if err != nil {
		return err
	}

	// Ensure directory exists
	dir := filepath.Dir(cm.config.ConfigPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// Write to file
	if err := os.WriteFile(cm.config.ConfigPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write Caddyfile: %w", err)
	}

	return nil
}

// generateCaddyfile generates the Caddyfile content
func (cm *CaddyManager) generateCaddyfile() (string, error) {
	tmpl := `# LibreServ Caddyfile
# Auto-generated - Do not edit manually

{
	{{if .Email}}email {{.Email}}{{end}}
	{{if not .AutoHTTPS}}auto_https off{{end}}
}

{{range .Routes}}
{{if .Enabled}}
{{.FullDomain}} {
	reverse_proxy {{.Backend}}
	{{if .SSL}}
	tls {
		on_demand
	}
	{{end}}
	
	# Security headers
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
	}
	
	# Logging
	log {
		output file /var/log/caddy/{{.Subdomain}}.log
	}
}
{{end}}
{{end}}
`

	t, err := template.New("caddyfile").Parse(tmpl)
	if err != nil {
		return "", fmt.Errorf("failed to parse template: %w", err)
	}

	data := struct {
		Email     string
		AutoHTTPS bool
		Routes    []*Route
	}{
		Email:     cm.config.Email,
		AutoHTTPS: cm.config.AutoHTTPS,
		Routes:    cm.ListRoutes(),
	}

	var buf bytes.Buffer
	if err := t.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("failed to execute template: %w", err)
	}

	return buf.String(), nil
}

// validateConfig validates the Caddyfile
func (cm *CaddyManager) validateConfig() error {
	// Write to temp file
	tmpFile, err := os.CreateTemp("", "caddyfile-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmpFile.Name())

	content, err := cm.generateCaddyfile()
	if err != nil {
		return err
	}

	if _, err := tmpFile.WriteString(content); err != nil {
		return err
	}
	tmpFile.Close()

	// Validate with caddy
	cmd := exec.Command("caddy", "validate", "--config", tmpFile.Name())
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("validation failed: %s", string(output))
	}

	return nil
}

// reloadCaddy reloads Caddy configuration
func (cm *CaddyManager) reloadCaddy() error {
	// Try admin API first
	if cm.config.AdminAPI != "" {
		content, err := os.ReadFile(cm.config.ConfigPath)
		if err != nil {
			return err
		}

		req, err := http.NewRequest("POST", cm.config.AdminAPI+"/load", bytes.NewReader(content))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "text/caddyfile")

		resp, err := cm.httpClient.Do(req)
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == 200 {
				return nil
			}
			body, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("reload failed: %s", string(body))
		}
		// Fall through to CLI method
	}

	// Use CLI reload
	cmd := exec.Command("caddy", "reload", "--config", cm.config.ConfigPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("reload failed: %s", string(output))
	}

	return nil
}

// backupCurrentConfig backs up the current Caddyfile
func (cm *CaddyManager) backupCurrentConfig() {
	content, err := os.ReadFile(cm.config.ConfigPath)
	if err == nil {
		cm.configBackup = string(content)
	}
}

// restoreBackup restores the backed up Caddyfile
func (cm *CaddyManager) restoreBackup() error {
	if cm.configBackup == "" {
		return nil
	}

	if err := os.WriteFile(cm.config.ConfigPath, []byte(cm.configBackup), 0644); err != nil {
		return err
	}

	return cm.reloadCaddy()
}

// loadRoutes loads routes from the database
func (cm *CaddyManager) loadRoutes(ctx context.Context) error {
	rows, err := cm.db.Query(`
		SELECT id, subdomain, domain, backend, app_id, ssl, enabled, created_at, updated_at
		FROM routes
	`)
	if err != nil {
		// Table might not exist, create it
		if strings.Contains(err.Error(), "no such table") {
			return cm.createRoutesTable()
		}
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var route Route
		err := rows.Scan(
			&route.ID, &route.Subdomain, &route.Domain, &route.Backend,
			&route.AppID, &route.SSL, &route.Enabled, &route.CreatedAt, &route.UpdatedAt,
		)
		if err != nil {
			continue
		}
		cm.routes[route.ID] = &route
	}

	return nil
}

// createRoutesTable creates the routes table if it doesn't exist
func (cm *CaddyManager) createRoutesTable() error {
	_, err := cm.db.Exec(`
		CREATE TABLE IF NOT EXISTS routes (
			id TEXT PRIMARY KEY,
			subdomain TEXT NOT NULL,
			domain TEXT NOT NULL,
			backend TEXT NOT NULL,
			app_id TEXT,
			ssl BOOLEAN DEFAULT TRUE,
			enabled BOOLEAN DEFAULT TRUE,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(subdomain, domain)
		)
	`)
	return err
}

// saveRoute saves a route to the database
func (cm *CaddyManager) saveRoute(ctx context.Context, route *Route) error {
	_, err := cm.db.Exec(`
		INSERT INTO routes (id, subdomain, domain, backend, app_id, ssl, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, route.ID, route.Subdomain, route.Domain, route.Backend, route.AppID, route.SSL, route.Enabled, route.CreatedAt, route.UpdatedAt)
	return err
}

// updateRouteInDB updates a route in the database
func (cm *CaddyManager) updateRouteInDB(ctx context.Context, route *Route) error {
	_, err := cm.db.Exec(`
		UPDATE routes SET backend = ?, enabled = ?, updated_at = ?
		WHERE id = ?
	`, route.Backend, route.Enabled, route.UpdatedAt, route.ID)
	return err
}

// deleteRoute deletes a route from the database
func (cm *CaddyManager) deleteRoute(ctx context.Context, routeID string) error {
	_, err := cm.db.Exec("DELETE FROM routes WHERE id = ?", routeID)
	return err
}

// GetCaddyfileContent returns the current Caddyfile content
func (cm *CaddyManager) GetCaddyfileContent() (string, error) {
	content, err := os.ReadFile(cm.config.ConfigPath)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

// TestBackend tests if a backend is reachable
func (cm *CaddyManager) TestBackend(backend string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", backend, nil)
	if err != nil {
		return err
	}

	resp, err := cm.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("backend unreachable: %w", err)
	}
	defer resp.Body.Close()

	// Any response is considered success (even 404)
	return nil
}

// CaddyAPIResponse represents a response from Caddy's API
type CaddyAPIResponse struct {
	Config json.RawMessage `json:"config,omitempty"`
	Error  string          `json:"error,omitempty"`
}
