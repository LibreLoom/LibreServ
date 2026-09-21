package network

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"log/slog"
	"math"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"text/template"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

type CaddyManager struct {
	db           *database.DB
	config       CaddyConfig
	routes       map[string]*Route
	routesMu     sync.RWMutex
	reloadMu     sync.Mutex
	httpClient   *http.Client
	configBackup string
	metrics      *monitoring.CaddyMetrics
	// onDefaultDomainChanged is invoked (outside any lock) after the default
	// domain changes and routes have been migrated, so higher layers can
	// re-register tunnel hostnames and update app configs.
	onDefaultDomainChanged func(oldDomain, newDomain string)
}

type routeView struct {
	ID               string
	FullDomain       string
	Backend          string
	SSL              bool
	Enabled          bool
	RestrictedAccess bool
	TLSCert          string
	TLSKey           string
}

type wildcardBlock struct {
	Domain  string
	TLSCert string
	TLSKey  string
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

// AdminEndpoint returns the admin API URL if configured.
func (cm *CaddyManager) AdminEndpoint() string {
	return cm.config.AdminAPI
}

// ConfigPath returns the Caddyfile path.
func (cm *CaddyManager) ConfigPath() string {
	return cm.config.ConfigPath
}

// WithMetrics sets the metrics collector for Caddy operations
func (cm *CaddyManager) WithMetrics(metrics *monitoring.CaddyMetrics) *CaddyManager {
	cm.metrics = metrics
	return cm
}

// SetOnDefaultDomainChanged registers a callback invoked after the default
// domain changes and all routes under the old domain have been migrated. It is
// called outside CaddyManager locks so the callback may re-register tunnel
// hostnames with Connect or update app configs without deadlocking.
func (cm *CaddyManager) SetOnDefaultDomainChanged(fn func(oldDomain, newDomain string)) {
	cm.onDefaultDomainChanged = fn
}

func (cm *CaddyManager) mode() string {
	m := strings.ToLower(strings.TrimSpace(cm.config.Mode))
	if m == "" {
		return "disabled"
	}
	return m
}

func (cm *CaddyManager) isEnabled() bool {
	return cm.mode() == "enabled"
}

// SetMode updates the CaddyManager's mode at runtime.
// Switching from disabled/noop to enabled triggers initialization and a config reload.
func (cm *CaddyManager) SetMode(mode string) error {
	m := strings.ToLower(strings.TrimSpace(mode))
	validModes := map[string]bool{"enabled": true, "disabled": true, "noop": true}
	if !validModes[m] {
		return fmt.Errorf("invalid caddy mode: %s", mode)
	}

	wasEnabled := cm.isEnabled()
	cm.config.Mode = m

	if !wasEnabled && cm.isEnabled() {
		if cm.config.ConfigPath == "" {
			return fmt.Errorf("cannot enable caddy: config_path not set")
		}
		if err := cm.Initialize(context.Background()); err != nil {
			slog.Warn("caddy initialization on mode change failed", "error", err)
			return err
		}
		slog.Info("caddy mode changed to enabled, initialized successfully")
	} else {
		slog.Info("caddy mode updated", "mode", m)
	}

	return nil
}

// UpdateDefaults updates domain/email/autohttps defaults and regenerates config.
// When the default domain changes, every route that was created under the old
// default domain is migrated to the new one (subdomain preserved), so apps
// keep working without manual reconfiguration — e.g. a Connect subdomain move
// (3a2b01ec.free.servers.libreloom.org → plainskill.servers.libreloom.org).
func (cm *CaddyManager) UpdateDefaults(defaultDomain, email string, autoHTTPS bool) error {
	cm.routesMu.Lock()
	oldDomain := cm.config.DefaultDomain
	if defaultDomain != "" {
		cm.config.DefaultDomain = defaultDomain
	}
	if email != "" {
		cm.config.Email = email
	}
	cm.config.AutoHTTPS = autoHTTPS

	// Migrate existing routes when the default domain changes. Only non-empty
	// domain switches migrate — disconnecting the domain (empty) leaves routes
	// untouched.
	if oldDomain != "" && defaultDomain != "" && oldDomain != defaultDomain {
		if err := cm.migrateRoutesLocked(oldDomain, defaultDomain); err != nil {
			cm.routesMu.Unlock()
			return err
		}
	}
	err := cm.regenerateCaddyfileLocked()
	cm.routesMu.Unlock()

	// Notify higher layers (apps manager) after the lock is released so they
	// can migrate app configs and re-register tunnel hostnames.
	if err == nil && oldDomain != "" && defaultDomain != "" && oldDomain != defaultDomain && cm.onDefaultDomainChanged != nil {
		cm.onDefaultDomainChanged(oldDomain, defaultDomain)
	}
	return err
}

// migrateRoutesLocked rewrites every route whose domain equals oldDomain to
// newDomain, both in the database and in memory, preserving each route's
// subdomain. Routes on custom domains (domain != oldDomain) are untouched.
// Caller must hold routesMu.
func (cm *CaddyManager) migrateRoutesLocked(oldDomain, newDomain string) error {
	now := time.Now()
	for id, r := range cm.routes {
		if r.Domain == oldDomain {
			r.Domain = newDomain
			r.UpdatedAt = now
			cm.routes[id] = r
		}
	}
	_, err := cm.db.Exec(
		`UPDATE routes SET domain = ?, updated_at = ? WHERE domain = ?`,
		newDomain, now, oldDomain,
	)
	if err != nil {
		return fmt.Errorf("migrate routes to new domain: %w", err)
	}
	slog.Info("migrated routes to new default domain", "old", oldDomain, "new", newDomain)
	return nil
}

// MigrateRoutes rewrites every route whose domain equals oldDomain to
// newDomain and regenerates the Caddyfile. Public entry point used at startup
// to heal routes that were created before the domain changed (see
// ReconcileConnectDomains). Returns the number of routes migrated.
func (cm *CaddyManager) MigrateRoutes(oldDomain, newDomain string) (int, error) {
	if oldDomain == "" || newDomain == "" || oldDomain == newDomain {
		return 0, nil
	}
	cm.routesMu.Lock()
	count := 0
	now := time.Now()
	for id, r := range cm.routes {
		if r.Domain == oldDomain {
			r.Domain = newDomain
			r.UpdatedAt = now
			cm.routes[id] = r
			count++
		}
	}
	res, err := cm.db.Exec(
		`UPDATE routes SET domain = ?, updated_at = ? WHERE domain = ?`,
		newDomain, now, oldDomain,
	)
	if err != nil {
		cm.routesMu.Unlock()
		return 0, fmt.Errorf("migrate routes to new domain: %w", err)
	}
	if n, _ := res.RowsAffected(); n > int64(count) {
		count = int(n)
	}
	err = cm.regenerateCaddyfileLocked()
	cm.routesMu.Unlock()
	if err != nil {
		return count, fmt.Errorf("regenerate Caddyfile after route migration: %w", err)
	}
	if count > 0 {
		slog.Info("migrated routes to new default domain", "old", oldDomain, "new", newDomain, "routes", count)
	}
	return count, nil
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
	// Validate inputs before acquiring locks
	if err := ValidateSubdomain(subdomain); err != nil {
		return nil, err
	}
	if domain == "" {
		domain = cm.config.DefaultDomain
	}
	if err := ValidateDomain(domain); err != nil {
		return nil, err
	}
	if err := ValidateBackend(backend); err != nil {
		return nil, err
	}

	cm.reloadMu.Lock()
	defer cm.reloadMu.Unlock()

	cm.routesMu.Lock()

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
		// Rollback is best effort — the caller still gets the original error —
		// but a failed rollback leaves an orphaned route row or a stale
		// Caddyfile, so it cannot be dropped silently.
		delete(cm.routes, route.ID)
		cm.rollbackRoute(ctx, route.ID)
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("failed to apply configuration: %w", err)
	}
	cm.routesMu.Unlock()

	if err := cm.reloadCaddy(); err != nil {
		// Keep the route even when the reload fails (e.g. Caddy is down or
		// not installed — common in dev). Rolling back would discard the
		// route and break the app's public URL; a later reload attempt will
		// pick the route up once Caddy is reachable.
		log.Printf("Route added %s but Caddy reload failed (kept route): %v", route.FullDomain(), err)
	}

	log.Printf("Route added: %s -> %s", route.FullDomain(), route.Backend)
	return route, nil
}

// AddDomainRoute adds a route for a full domain (no default domain prefix).
func (cm *CaddyManager) AddDomainRoute(ctx context.Context, domain, backend, comment string) (*Route, error) {
	// Validate inputs before acquiring locks
	if err := ValidateDomain(domain); err != nil {
		return nil, err
	}
	if err := ValidateBackend(backend); err != nil {
		return nil, err
	}

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
		cm.rollbackRoute(ctx, route.ID)
		cm.routesMu.Unlock()
		return nil, fmt.Errorf("failed to apply configuration: %w", err)
	}
	cm.routesMu.Unlock()

	if err := cm.reloadCaddy(); err != nil {
		// Keep the route — reload failure (Caddy down/not installed) must not
		// discard the route and break the app's public URL.
		log.Printf("Route updated %s but Caddy reload failed (kept route): %v", route.FullDomain(), err)
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
		cm.restoreBackupLogged()
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
	// Validate backend before acquiring locks
	if err := ValidateBackend(backend); err != nil {
		return nil, err
	}

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
		cm.restoreBackupLogged()
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
			_ = resp.Body.Close()
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
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// Write to file
	if err := os.WriteFile(cm.config.ConfigPath, []byte(content), 0640); err != nil {
		return fmt.Errorf("failed to write Caddyfile: %w", err)
	}

	return nil
}

var ipRegex = regexp.MustCompile(`^(\d{1,3}\.){3}\d{1,3}$|^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$`)

func hasRealDomain(routes []routeView) bool {
	for _, r := range routes {
		domain := strings.ToLower(r.FullDomain)
		if domain == "localhost" || domain == "127.0.0.1" || domain == "::1" {
			continue
		}
		if ipRegex.MatchString(domain) {
			continue
		}
		return true
	}
	return false
}

// generateCaddyfileLocked generates the Caddyfile content without taking any locks.
// The caller must hold cm.routesMu (read or write) when calling this method.
func (cm *CaddyManager) generateCaddyfileLocked() (string, error) {
	tmpl := `# LibreServ Caddyfile
# Auto-generated - Do not edit manually

{
	{{if .Email}}email {{.Email}}{{end}}
	{{if not .AutoHTTPS}}auto_https off{{end}}
	{{if .AutoHTTPS}}
	tls {
		on_demand {
			rate_limit 10
		}
	}
	{{end}}
}

{{if and .AutoHTTPS .HasRealDomains}}
# HTTP to HTTPS redirect for all domains
http:// {
	redir https://{host}{uri} 308
}
{{end}}

{{range .Routes}}
{{if .Enabled}}
{{.FullDomain}} {
	{{if .RestrictedAccess}}
	# Access control — LibreServ checks the user's session before allowing access
	forward_auth 127.0.0.1:{{$.AuthPort}} {
		uri /api/v1/auth/forward-auth
		copy_headers Remote-User Remote-Email Remote-Groups
	}
	{{end}}
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
		Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
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

{{range .WildcardBlocks}}
# Catch-all for unconfigured subdomains of {{.Domain}}
*.{{.Domain}} {
	respond 404
	tls {{.TLSCert}} {{.TLSKey}}
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
		Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
	}
}
{{end}}
`

	t, err := template.New("caddyfile").Parse(tmpl)
	if err != nil {
		return "", fmt.Errorf("failed to parse template: %w", err)
	}

	routes := cm.listRoutesLocked()
	views := make([]routeView, 0, len(routes))
	for _, r := range routes {
		v := routeView{
			ID:               r.ID,
			FullDomain:       r.FullDomain(),
			Backend:          r.Backend,
			SSL:              r.SSL,
			Enabled:          r.Enabled,
			RestrictedAccess: r.RestrictedAccess,
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
		Email          string
		AutoHTTPS      bool
		HasRealDomains bool
		Routes         []routeView
		WildcardBlocks []wildcardBlock
		LogOutput      string
		LogFormat      string
		LogLevel       string
		AuthPort       int
	}{
		Email:          cm.config.Email,
		AutoHTTPS:      cm.config.AutoHTTPS,
		HasRealDomains: hasRealDomain(views),
		Routes:         views,
		WildcardBlocks: cm.wildcardBlocksLocked(),
		LogOutput:      cm.loggingOutput(),
		LogFormat:      cm.loggingFormat(),
		LogLevel:       strings.TrimSpace(cm.config.Logging.Level),
		AuthPort:       cm.config.AuthPort,
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
	certPath, keyPath, ok = cm.certPathsForDomain(domain)
	if ok {
		return
	}
	parts := strings.SplitN(domain, ".", 2)
	if len(parts) == 2 && !strings.HasPrefix(parts[0], "*") {
		wildcard := "*." + parts[1]
		certPath, keyPath, ok = cm.certPathsForDomain(wildcard)
	}
	return
}

// certDirForDomain returns the canonical per-domain certificates directory
// under CertsPath, using the same safeDomainDir mapping as cert storage.
// It returns "" when no CertsPath is configured.
func (cm *CaddyManager) certDirForDomain(domain string) string {
	base := strings.TrimSpace(cm.config.CertsPath)
	if base == "" {
		return ""
	}
	return filepath.Join(base, safeDomainDir(domain))
}

func (cm *CaddyManager) certPathsForDomain(domain string) (certPath, keyPath string, ok bool) {
	dir := cm.certDirForDomain(domain)
	if dir == "" {
		return "", "", false
	}
	cert := filepath.Join(dir, "fullchain.pem")
	key := filepath.Join(dir, "privkey.pem")
	if fileExists(cert) && fileExists(key) {
		return cert, key, true
	}
	return "", "", false
}

func (cm *CaddyManager) wildcardBlocksLocked() []wildcardBlock {
	base := strings.TrimSpace(cm.config.CertsPath)
	if base == "" {
		return nil
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil
	}
	var blocks []wildcardBlock
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "wildcard.") {
			continue
		}
		domain := strings.TrimPrefix(name, "wildcard.")
		wildcard := "*." + domain
		cert, key, ok := cm.certPathsForDomain(wildcard)
		if !ok {
			continue
		}
		blocks = append(blocks, wildcardBlock{
			Domain:  domain,
			TLSCert: cert,
			TLSKey:  key,
		})
	}
	return blocks
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
	defer func() { _ = os.Remove(tmpFile.Name()) }()

	content, err := cm.generateCaddyfileLocked()
	if err != nil {
		return err
	}

	if _, err := tmpFile.WriteString(content); err != nil {
		return err
	}
	_ = tmpFile.Close()

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

// isLoopbackAdminAPI reports whether the admin API URL is bound to loopback only.
// SECURITY FIX (audit #8): Caddy Admin API has no auth. If it were bound to
// 0.0.0.0:2019 or a podman-bridge-reachable IP, any container could POST
// /load and replace the reverse proxy. We enforce loopback so only host
// processes can reach it. Operators needing remote admin must explicitly
// configure 127.0.0.1:2019 and use SSH tunneling.
func isLoopbackAdminAPI(adminAPI string) bool {
	if adminAPI == "" {
		return true
	}
	host := adminAPI
	// Strip scheme if present (http://host:port)
	if idx := strings.Index(host, "://"); idx != -1 {
		host = host[idx+3:]
	}
	if idx := strings.Index(host, "/"); idx != -1 {
		host = host[:idx]
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "127.0.1.1" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}

// reloadCaddy reloads Caddy configuration
func (cm *CaddyManager) reloadCaddy() error {
	start := time.Now()
	var attemptCount int

	// In noop/disabled mode, never attempt to reload.
	// noop mode: silently succeed (useful for dev/testing)
	// disabled mode: return error to signal misconfiguration
	m := cm.mode()
	if m == "disabled" {
		if cm.metrics != nil {
			cm.metrics.RecordReload(false, time.Since(start), 0)
		}
		return &CaddyError{Op: "reload", Err: ErrCaddyDisabled, Context: "mode=disabled"}
	}
	if m == "noop" {
		// No-op: succeed without actually reloading
		if cm.metrics != nil {
			cm.metrics.RecordReload(true, time.Since(start), 0)
		}
		return nil
	}
	if !cm.isEnabled() {
		if cm.metrics != nil {
			cm.metrics.RecordReload(true, time.Since(start), 0)
		}
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

	// SECURITY FIX (audit #8): reject non-loopback AdminAPI — it would be reachable
	// from containers via the Podman bridge (172.17.0.1) and allow host proxy takeover.
	if cm.config.AdminAPI != "" && !isLoopbackAdminAPI(cm.config.AdminAPI) {
		slog.Warn("caddy admin API is not loopback — refusing to use non-loopback admin endpoint", "admin_api", cm.config.AdminAPI)
		return fmt.Errorf("caddy admin_api must be loopback (127.0.0.1:2019 or localhost:2019), got %s — containers could otherwise reach the unauthenticated admin API", cm.config.AdminAPI)
	}

	// Try admin API first
	if cm.config.AdminAPI != "" {
		content, err := os.ReadFile(cm.config.ConfigPath)
		if err != nil {
			if cm.metrics != nil {
				cm.metrics.RecordReload(false, time.Since(start), 0)
			}
			return err
		}

		var lastErr error
		for attempt := 0; attempt <= retries; attempt++ {
			attemptCount = attempt + 1
			ctx, cancel := context.WithTimeout(context.Background(), attemptTimeout)
			req, err := http.NewRequestWithContext(ctx, "POST", cm.config.AdminAPI+"/load", bytes.NewReader(content))
			if err != nil {
				cancel()
				if cm.metrics != nil {
					cm.metrics.RecordReload(false, time.Since(start), attemptCount)
				}
				return err
			}
			req.Header.Set("Content-Type", "text/caddyfile")

			resp, err := cm.httpClient.Do(req)
			if err == nil {
				body, _ := io.ReadAll(resp.Body)
				_ = resp.Body.Close()
				cancel()
				if resp.StatusCode == http.StatusOK {
					if cm.metrics != nil {
						cm.metrics.RecordReload(true, time.Since(start), attemptCount)
					}
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
			time.Sleep(backoffWithJitter(backoffMin, backoffMax, attempt, jitter))
		}

		// Fall through to CLI method as a last resort (if available).
		if lastErr != nil {
			log.Printf("Caddy admin reload failed after retries; attempting CLI reload: %v", lastErr)
		}
	}

	// Use CLI reload if available
	if _, err := exec.LookPath("caddy"); err != nil {
		if cm.metrics != nil {
			cm.metrics.RecordReload(false, time.Since(start), attemptCount)
		}
		return fmt.Errorf("caddy binary not found and admin API not configured")
	}
	cmd := exec.Command("caddy", "reload", "--config", cm.config.ConfigPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if cm.metrics != nil {
			cm.metrics.RecordReload(false, time.Since(start), attemptCount)
		}
		return fmt.Errorf("reload failed: %s", string(output))
	}

	if cm.metrics != nil {
		cm.metrics.RecordReload(true, time.Since(start), attemptCount)
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

func cryptoRandFloat64() float64 {
	n, err := rand.Int(rand.Reader, big.NewInt(1<<53))
	if err != nil {
		return 0
	}
	return float64(n.Int64()) / float64(1<<53)
}

func backoffWithJitter(min, max time.Duration, attempt int, jitterFraction float64) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	base := float64(min) * math.Pow(2, float64(attempt))
	if base > float64(max) {
		base = float64(max)
	}
	if jitterFraction <= 0 {
		return time.Duration(base)
	}
	j := (cryptoRandFloat64()*2 - 1) * jitterFraction
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

// restoreBackupLogged reverts the Caddyfile after a failed apply. The caller
// already returns the original failure, so this only reports that the rollback
// itself did not land and the on-disk config no longer matches the route table.
func (cm *CaddyManager) restoreBackupLogged() {
	if err := cm.restoreBackup(); err != nil {
		slog.Error("failed to restore Caddyfile backup; on-disk config may not match stored routes", "error", err)
	}
}

// rollbackRoute undoes a partially applied route: it removes the persisted row
// and reverts the Caddyfile. Failures leave inconsistent state behind, so they
// are logged rather than discarded.
func (cm *CaddyManager) rollbackRoute(ctx context.Context, routeID string) {
	if err := cm.deleteRoute(ctx, routeID); err != nil {
		slog.Error("failed to roll back route row; orphaned route left in database", "route_id", routeID, "error", err)
	}
	cm.restoreBackupLogged()
}

// restoreBackup restores the backed up Caddyfile
func (cm *CaddyManager) restoreBackup() error {
	if cm.configBackup == "" {
		return nil
	}

	if err := os.WriteFile(cm.config.ConfigPath, []byte(cm.configBackup), 0640); err != nil {
		return err
	}

	return cm.reloadCaddy()
}

// loadRoutes loads routes from the database
func (cm *CaddyManager) loadRoutes(ctx context.Context) error {
	rows, err := cm.db.Query(`
		SELECT id, subdomain, domain, backend, app_id, ssl, enabled, restricted_access, created_at, updated_at
		FROM routes
	`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var route Route
		err := rows.Scan(
			&route.ID, &route.Subdomain, &route.Domain, &route.Backend,
			&route.AppID, &route.SSL, &route.Enabled, &route.RestrictedAccess, &route.CreatedAt, &route.UpdatedAt,
		)
		if err != nil {
			slog.Error("failed to scan route row; route will not be served", "error", err)
			continue
		}
		cm.routes[route.ID] = &route
	}
	if err := rows.Err(); err != nil {
		// A partial route set would regenerate a Caddyfile that quietly drops
		// the missing routes.
		return fmt.Errorf("failed to iterate routes: %w", err)
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
		INSERT INTO routes (id, subdomain, domain, backend, app_id, ssl, enabled, restricted_access, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, route.ID, route.Subdomain, route.Domain, route.Backend, route.AppID, route.SSL, route.Enabled, route.RestrictedAccess, route.CreatedAt, route.UpdatedAt)
	return err
}

// updateRouteInDB updates a route in the database
func (cm *CaddyManager) updateRouteInDB(ctx context.Context, route *Route) error {
	_, err := cm.db.Exec(`
		UPDATE routes SET backend = ?, enabled = ?, restricted_access = ?, updated_at = ?
		WHERE id = ?
	`, route.Backend, route.Enabled, route.RestrictedAccess, route.UpdatedAt, route.ID)
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
	defer func() { _ = resp.Body.Close() }()

	// Any response is considered success (even 404)
	return nil
}

// CaddyAPIResponse represents a response from Caddy's API
type CaddyAPIResponse struct {
	Config json.RawMessage `json:"config,omitempty"`
	Error  string          `json:"error,omitempty"`
}
