package network

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
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
	reloadMu     sync.Mutex
	httpClient   *http.Client
	configBackup string
	rand         *rand.Rand
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
		rand: rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// AdminEndpoint returns the admin API URL if configured.
func (cm *CaddyManager) AdminEndpoint() string {
	return cm.config.AdminAPI
}

// ConfigPath returns the Caddyfile path.
func (cm *CaddyManager) ConfigPath() string {
	return cm.config.ConfigPath
}

func (cm *CaddyManager) mode() string {
	m := strings.ToLower(strings.TrimSpace(cm.config.Mode))
	if m == "" {
		return "enabled"
	}
	return m
}

func (cm *CaddyManager) isEnabled() bool {
	return cm.mode() == "enabled"
}

func (cm *CaddyManager) isDisabled() bool {
	m := cm.mode()
	return m == "disabled" || m == "noop"
}

// UpdateDefaults updates domain/email/autohttps defaults and regenerates config.
func (cm *CaddyManager) UpdateDefaults(defaultDomain, email string, autoHTTPS bool) error {
	cm.routesMu.Lock()
	defer cm.routesMu.Unlock()
	if defaultDomain != "" {
		cm.config.DefaultDomain = defaultDomain
	}
	if email != "" {
		cm.config.Email = email
	}
	cm.config.AutoHTTPS = autoHTTPS
	return cm.regenerateCaddyfileLocked()
}

// Config returns the underlying Caddy configuration.
func (cm *CaddyManager) Config() CaddyConfig {
	return cm.config
}

// Initialize loads existing routes and validates Caddy configuration
func (cm *CaddyManager) Initialize(ctx context.Context) error {
	if cm.config.ConfigPath == "" {
		return fmt.Errorf("caddy config path is required")
	}
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

// AddRoute adds a new route for an app (subdomain + domain).
// If domain is empty, cm.config.DefaultDomain is used.
func (cm *CaddyManager) AddRoute(ctx context.Context, subdomain, domain, backend, appID string) (*Route, error) {
	cm.reloadMu.Lock()
	defer cm.reloadMu.Unlock()

	cm.routesMu.Lock()

	if domain == "" {
		domain = cm.config.DefaultDomain
	}

	// Check if route already exists
	fullDomain := subdomain + "." + domain
	if !cm.isAvailable(fullDomain) {
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("route for %s already exists", fullDomain)
	}

	// Backup current config
	cm.backupCurrentConfig()

	// Create new route
	route := &Route{
		ID:        uuid.New().String(),
		Subdomain: subdomain,
		Domain:    domain,
		Backend:   backend,
		AppID:     appID,
		SSL:       cm.config.AutoHTTPS,
		Enabled:   true,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	// Validate the new configuration
	cm.routes[route.ID] = route
	if err := cm.validateConfigLocked(); err != nil {
		delete(cm.routes, route.ID)
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	// Save to database
	if err := cm.saveRoute(ctx, route); err != nil {
		delete(cm.routes, route.ID)
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("failed to save route: %w", err)
	}

	// Apply the new configuration
	if err := cm.regenerateCaddyfileLocked(); err != nil {
		// Rollback
		delete(cm.routes, route.ID)
		cm.deleteRoute(ctx, route.ID)
		cm.restoreBackup()
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("failed to apply configuration: %w", err)
	}
	cm.routesMu.Unlock()

	if err := cm.reloadCaddy(); err != nil {
		// Rollback (requires re-locking)
		cm.routesMu.Lock()
		delete(cm.routes, route.ID)
		cm.deleteRoute(ctx, route.ID)
		cm.restoreBackup()
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("failed to reload Caddy: %w", err)
	}

	log.Printf("Route added: %s -> %s", route.FullDomain(), route.Backend)
	return route, nil
}

// AddDomainRoute adds a route for a full domain (no default domain prefix).
func (cm *CaddyManager) AddDomainRoute(ctx context.Context, domain, backend, comment string) (*Route, error) {
	cm.reloadMu.Lock()
	defer cm.reloadMu.Unlock()

	cm.routesMu.Lock()

	if !cm.isAvailable(domain) {
		if existing, ok := cm.findByDomain(domain); ok {
			cm.routesMu.Unlock()
			return existing, nil
		}
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("route for %s already exists", domain)
	}
	cm.backupCurrentConfig()
	route := &Route{
		ID:        uuid.New().String(),
		Subdomain: "",
		Domain:    domain,
		Backend:   backend,
		AppID:     "",
		SSL:       true,
		Enabled:   true,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
		Comment:   comment,
	}
	cm.routes[route.ID] = route
	if err := cm.validateConfigLocked(); err != nil {
		delete(cm.routes, route.ID)
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}
	if err := cm.saveRoute(ctx, route); err != nil {
		delete(cm.routes, route.ID)
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("failed to save route: %w", err)
	}
	if err := cm.regenerateCaddyfileLocked(); err != nil {
		delete(cm.routes, route.ID)
		_ = cm.deleteRoute(ctx, route.ID)
		cm.restoreBackup()
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("failed to apply configuration: %w", err)
	}
	cm.routesMu.Unlock()

	if err := cm.reloadCaddy(); err != nil {
		cm.routesMu.Lock()
		delete(cm.routes, route.ID)
		_ = cm.deleteRoute(ctx, route.ID)
		cm.restoreBackup()
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("failed to reload Caddy: %w", err)
	}
	return route, nil
}

// RemoveRoute removes a route
func (cm *CaddyManager) RemoveRoute(ctx context.Context, routeID string) error {
	cm.reloadMu.Lock()
	defer cm.reloadMu.Unlock()

	cm.routesMu.Lock()

	route, ok := cm.routes[routeID]
	if !ok {
		cm.routesMu.Unlock()
		return fmt.Errorf("route not found: %s", routeID)
	}

	// Backup current config
	cm.backupCurrentConfig()

	// Remove from memory
	delete(cm.routes, routeID)

	// Regenerate Caddyfile
	if err := cm.regenerateCaddyfileLocked(); err != nil {
		cm.routes[routeID] = route
		cm.routesMu.Unlock()
		return fmt.Errorf("failed to regenerate configuration: %w", err)
	}
	cm.routesMu.Unlock()

	// Reload Caddy
	if err := cm.reloadCaddy(); err != nil {
		cm.routesMu.Lock()
		cm.routes[routeID] = route
		cm.restoreBackup()
		cm.routesMu.Unlock()
		return fmt.Errorf("failed to reload Caddy: %w", err)
	}

	// Delete from database
	if err := cm.deleteRoute(ctx, routeID); err != nil {
		log.Printf("Warning: failed to delete route from database: %v", err)
	}

	log.Printf("Route removed: %s", route.FullDomain())
	return nil
}

// IsDomainAvailable reports whether subdomain+domain (or full domain) is unused.
func (cm *CaddyManager) IsDomainAvailable(subdomain, domain string) bool {
	if domain == "" {
		domain = cm.config.DefaultDomain
	}
	full := subdomain
	if full != "" {
		full = full + "." + domain
	} else {
		full = domain
	}
	cm.routesMu.RLock()
	defer cm.routesMu.RUnlock()
	return cm.isAvailable(full)
}

func (cm *CaddyManager) isAvailable(fullDomain string) bool {
	for _, r := range cm.routes {
		if r.FullDomain() == fullDomain {
			return false
		}
	}
	return true
}

func (cm *CaddyManager) findByDomain(fullDomain string) (*Route, bool) {
	for _, r := range cm.routes {
		if r.FullDomain() == fullDomain {
			return r, true
		}
	}
	return nil, false
}

// UpdateRoute updates an existing route
func (cm *CaddyManager) UpdateRoute(ctx context.Context, routeID string, backend string, enabled bool) (*Route, error) {
	cm.reloadMu.Lock()
	defer cm.reloadMu.Unlock()

	cm.routesMu.Lock()

	route, ok := cm.routes[routeID]
	if !ok {
		cm.routesMu.Unlock()
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
	if err := cm.regenerateCaddyfileLocked(); err != nil {
		route.Backend = oldBackend
		route.Enabled = oldEnabled
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("failed to regenerate configuration: %w", err)
	}
	cm.routesMu.Unlock()

	if err := cm.reloadCaddy(); err != nil {
		cm.routesMu.Lock()
		route.Backend = oldBackend
		route.Enabled = oldEnabled
		cm.restoreBackup()
		cm.routesMu.Unlock()
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

// FindRouteByDomain returns a route matching the full domain if it exists.
func (cm *CaddyManager) FindRouteByDomain(domain string) (*Route, bool) {
	cm.routesMu.RLock()
	defer cm.routesMu.RUnlock()
	for _, route := range cm.routes {
		if route.FullDomain() == domain {
			return route, true
		}
	}
	return nil, false
}

// ListRoutes returns all routes
func (cm *CaddyManager) ListRoutes() []*Route {
	cm.routesMu.RLock()
	defer cm.routesMu.RUnlock()

	return cm.listRoutesLocked()
}

// listRoutesLocked returns a snapshot of routes without taking any locks.
// The caller must hold cm.routesMu (read or write) when calling this method.
func (cm *CaddyManager) listRoutesLocked() []*Route {
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
		Mode:   cm.mode(),
	}

	// In noop/disabled mode, avoid probing Caddy and just report configuration state.
	if !cm.isEnabled() {
		status.Running = false
		status.Error = "caddy mode is " + cm.mode()
		// Get configured domains
		cm.routesMu.RLock()
		for _, route := range cm.routes {
			if route.Enabled {
				status.Domains = append(status.Domains, route.FullDomain())
			}
		}
		cm.routesMu.RUnlock()
		// Validate config best-effort
		status.ConfigValid = cm.validateConfig() == nil
		return status, nil
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
		// No admin API configured; only check process existence if binary available.
		if _, err := exec.LookPath("caddy"); err == nil {
			cmd := exec.Command("pgrep", "-x", "caddy")
			if err := cmd.Run(); err == nil {
				status.Running = true
			}
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
	cm.routesMu.RLock()
	defer cm.routesMu.RUnlock()
	return cm.regenerateCaddyfileLocked()
}

// regenerateCaddyfileLocked generates and writes the Caddyfile without taking any locks.
// The caller must hold cm.routesMu (read or write) when calling this method.
func (cm *CaddyManager) regenerateCaddyfileLocked() error {
	content, err := cm.generateCaddyfileLocked()
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
	cm.routesMu.RLock()
	defer cm.routesMu.RUnlock()
	return cm.generateCaddyfileLocked()
}

// generateCaddyfileLocked generates the Caddyfile content without taking any locks.
// The caller must hold cm.routesMu (read or write) when calling this method.
func (cm *CaddyManager) generateCaddyfileLocked() (string, error) {
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
	{{if .TLSCert}}
	tls {{.TLSCert}} {{.TLSKey}}
	{{else if $.AutoHTTPS}}
	tls {
		on_demand
	}
	{{end}}
	{{end}}
	
	# Security headers
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
	}
	
	# Logging
	{{if $.LogOutput}}log {
		output {{$.LogOutput}}
		{{if $.LogFormat}}format {{$.LogFormat}}{{end}}
		{{if $.LogLevel}}level {{$.LogLevel}}{{end}}
	}{{end}}
}
{{end}}
{{end}}
`

	t, err := template.New("caddyfile").Parse(tmpl)
	if err != nil {
		return "", fmt.Errorf("failed to parse template: %w", err)
	}

	type routeView struct {
		ID         string
		FullDomain string
		Backend    string
		SSL        bool
		Enabled    bool
		TLSCert    string
		TLSKey     string
	}

	routes := cm.listRoutesLocked()
	views := make([]routeView, 0, len(routes))
	for _, r := range routes {
		v := routeView{
			ID:         r.ID,
			FullDomain: r.FullDomain(),
			Backend:    r.Backend,
			SSL:        r.SSL,
			Enabled:    r.Enabled,
		}
		if r.SSL {
			if cert, key, ok := cm.manualTLSPaths(r.FullDomain()); ok {
				v.TLSCert = cert
				v.TLSKey = key
			}
		}
		views = append(views, v)
	}

	data := struct {
		Email     string
		AutoHTTPS bool
		Routes    []routeView
		LogOutput string
		LogFormat string
		LogLevel  string
	}{
		Email:     cm.config.Email,
		AutoHTTPS: cm.config.AutoHTTPS,
		Routes:    views,
		LogOutput: cm.loggingOutput(),
		LogFormat: cm.loggingFormat(),
		LogLevel:  strings.TrimSpace(cm.config.Logging.Level),
	}

	var buf bytes.Buffer
	if err := t.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("failed to execute template: %w", err)
	}

	return buf.String(), nil
}

func (cm *CaddyManager) loggingOutput() string {
	out := strings.ToLower(strings.TrimSpace(cm.config.Logging.Output))
	switch out {
	case "stderr":
		return "stderr"
	case "file":
		path := strings.TrimSpace(cm.config.Logging.File)
		if path == "" {
			return "stdout"
		}
		return "file " + path
	case "", "stdout":
		return "stdout"
	default:
		return "stdout"
	}
}

func (cm *CaddyManager) loggingFormat() string {
	f := strings.ToLower(strings.TrimSpace(cm.config.Logging.Format))
	switch f {
	case "json":
		return "json"
	case "console", "":
		return ""
	default:
		return ""
	}
}

func (cm *CaddyManager) manualTLSPaths(domain string) (certPath, keyPath string, ok bool) {
	base := strings.TrimSpace(cm.config.CertsPath)
	if base == "" {
		return "", "", false
	}
	dir := filepath.Join(base, safeDomainDir(domain))
	cert := filepath.Join(dir, "fullchain.pem")
	key := filepath.Join(dir, "privkey.pem")
	if fileExists(cert) && fileExists(key) {
		return cert, key, true
	}
	return "", "", false
}

func safeDomainDir(domain string) string {
	// Keep it stable and filesystem-safe, even for odd inputs.
	d := strings.ToLower(strings.TrimSpace(domain))
	if d == "" {
		return "_"
	}
	var b strings.Builder
	b.Grow(len(d))
	for _, r := range d {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '.' || r == '-' || r == '_':
			b.WriteRune(r)
		case r == '*':
			b.WriteString("wildcard")
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

// validateConfig validates the Caddyfile
func (cm *CaddyManager) validateConfig() error {
	cm.routesMu.RLock()
	defer cm.routesMu.RUnlock()
	return cm.validateConfigLocked()
}

// validateConfigLocked validates the Caddyfile without taking any locks.
// The caller must hold cm.routesMu (read or write) when calling this method.
func (cm *CaddyManager) validateConfigLocked() error {
	// Write to temp file
	tmpFile, err := os.CreateTemp("", "caddyfile-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmpFile.Name())

	content, err := cm.generateCaddyfileLocked()
	if err != nil {
		return err
	}

	if _, err := tmpFile.WriteString(content); err != nil {
		return err
	}
	tmpFile.Close()

	// Validate with caddy if available; otherwise skip with warning
	if _, err := exec.LookPath("caddy"); err != nil {
		return nil
	}

	cmd := exec.Command("caddy", "validate", "--config", tmpFile.Name())
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("validation failed: %s", string(output))
	}

	return nil
}

// reloadCaddy reloads Caddy configuration
func (cm *CaddyManager) reloadCaddy() error {
	// In noop/disabled mode, never attempt to reload.
	// noop mode: silently succeed (useful for dev/testing)
	// disabled mode: return error to signal misconfiguration
	m := cm.mode()
	if m == "disabled" {
		return &CaddyError{Op: "reload", Err: ErrCaddyDisabled, Context: "mode=disabled"}
	}
	if m == "noop" {
		// No-op: succeed without actually reloading
		return nil
	}
	if !cm.isEnabled() {
		return nil
	}

	retries := cm.config.Reload.Retries
	if retries <= 0 {
		retries = 5
	}
	backoffMin := cm.config.Reload.BackoffMin
	if backoffMin <= 0 {
		backoffMin = 200 * time.Millisecond
	}
	backoffMax := cm.config.Reload.BackoffMax
	if backoffMax <= 0 {
		backoffMax = 5 * time.Second
	}
	attemptTimeout := cm.config.Reload.AttemptTimeout
	if attemptTimeout <= 0 {
		attemptTimeout = 5 * time.Second
	}
	jitter := cm.config.Reload.JitterFraction
	if jitter < 0 {
		jitter = 0
	}

	// Try admin API first
	if cm.config.AdminAPI != "" {
		content, err := os.ReadFile(cm.config.ConfigPath)
		if err != nil {
			return err
		}

		var lastErr error
		for attempt := 0; attempt <= retries; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), attemptTimeout)
			req, err := http.NewRequestWithContext(ctx, "POST", cm.config.AdminAPI+"/load", bytes.NewReader(content))
			if err != nil {
				cancel()
				return err
			}
			req.Header.Set("Content-Type", "text/caddyfile")

			resp, err := cm.httpClient.Do(req)
			if err == nil {
				body, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				cancel()
				if resp.StatusCode == http.StatusOK {
					return nil
				}
				lastErr = fmt.Errorf("caddy admin reload rejected (status=%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
				if !isRetryableStatus(resp.StatusCode) {
					break
				}
			} else {
				cancel()
				lastErr = fmt.Errorf("caddy admin reload failed: %w", err)
			}

			if attempt == retries {
				break
			}
			time.Sleep(backoffWithJitter(cm.rand, backoffMin, backoffMax, attempt, jitter))
		}

		// Fall through to CLI method as a last resort (if available).
		if lastErr != nil {
			log.Printf("Caddy admin reload failed after retries; attempting CLI reload: %v", lastErr)
		}
	}

	// Use CLI reload if available
	if _, err := exec.LookPath("caddy"); err != nil {
		return fmt.Errorf("caddy binary not found and admin API not configured")
	}
	cmd := exec.Command("caddy", "reload", "--config", cm.config.ConfigPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("reload failed: %s", string(output))
	}

	return nil
}

func isRetryableStatus(code int) bool {
	switch code {
	case http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func backoffWithJitter(r *rand.Rand, min, max time.Duration, attempt int, jitterFraction float64) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	// Exponential backoff: min * 2^attempt, capped at max.
	base := float64(min) * math.Pow(2, float64(attempt))
	if base > float64(max) {
		base = float64(max)
	}
	if jitterFraction <= 0 || r == nil {
		return time.Duration(base)
	}
	// Apply +/- jitterFraction.
	j := (r.Float64()*2 - 1) * jitterFraction // [-jitter, +jitter]
	val := base * (1 + j)
	if val < float64(min) {
		val = float64(min)
	}
	if val > float64(max) {
		val = float64(max)
	}
	return time.Duration(val)
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

// ApplyConfig regenerates the Caddyfile and reloads Caddy.
func (cm *CaddyManager) ApplyConfig() error {
	cm.reloadMu.Lock()
	defer cm.reloadMu.Unlock()

	cm.routesMu.Lock()
	if err := cm.regenerateCaddyfileLocked(); err != nil {
		cm.routesMu.Unlock()
		return err
	}
	cm.routesMu.Unlock()
	return cm.reloadCaddy()
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
