package network

import (
	"errors"
	"fmt"
	"time"
)

// Structured error types for Caddy operations
var (
	ErrCaddyDisabled      = errors.New("caddy is disabled")
	ErrAdminUnreachable   = errors.New("caddy admin API unreachable")
	ErrReloadRejected     = errors.New("caddy reload rejected")
	ErrConfigInvalid      = errors.New("caddy config invalid")
	ErrRouteNotFound      = errors.New("route not found")
	ErrRouteDuplicate     = errors.New("route already exists")
	ErrBackendUnreachable = errors.New("backend unreachable")
	ErrInvalidDomain      = errors.New("invalid domain name")
	ErrInvalidBackend     = errors.New("invalid backend URL")
)

// CaddyError wraps an error with additional context about Caddy operations
type CaddyError struct {
	Op      string // operation that failed (e.g., "reload", "validate", "add_route")
	Err     error  // underlying error
	Context string // additional context
}

func (e *CaddyError) Error() string {
	if e.Context != "" {
		return fmt.Sprintf("%s: %v (%s)", e.Op, e.Err, e.Context)
	}
	return fmt.Sprintf("%s: %v", e.Op, e.Err)
}

func (e *CaddyError) Unwrap() error {
	return e.Err
}

// Route represents a reverse proxy route
type Route struct {
	ID        string    `json:"id"`
	Subdomain string    `json:"subdomain"` // e.g., "nextcloud"
	Domain    string    `json:"domain"`    // e.g., "example.com"
	Backend   string    `json:"backend"`   // e.g., "http://localhost:8080"
	AppID     string    `json:"app_id"`    // Reference to the app
	SSL       bool      `json:"ssl"`       // Enable HTTPS
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Comment   string    `json:"comment,omitempty"`
}

// FullDomain returns the complete domain name
func (r *Route) FullDomain() string {
	if r.Subdomain == "" {
		return r.Domain
	}
	return r.Subdomain + "." + r.Domain
}

// CaddyConfig represents the configuration for Caddy
type CaddyConfig struct {
	// Mode controls Caddy integration behavior:
	// - "enabled": generate config + attempt reloads (default)
	// - "noop": generate config but never reload (useful for dev/tests)
	// - "disabled": do not reload; status should report disabled
	Mode string `yaml:"mode" json:"mode"`
	// AdminAPI is the URL for Caddy's admin API
	AdminAPI string `yaml:"admin_api" json:"admin_api"`
	// ConfigPath is the path to the Caddyfile
	ConfigPath string `yaml:"config_path" json:"config_path"`
	// CertsPath is where manual/external certificates are stored (per-domain subdirs).
	// When present and a cert/key exists for a route's domain, the generated Caddyfile
	// will use `tls <cert> <key>` instead of on-demand/automatic issuance.
	CertsPath string `yaml:"certs_path" json:"certs_path"`
	// DefaultDomain is the base domain for apps
	DefaultDomain string `yaml:"default_domain" json:"default_domain"`
	// Email for ACME/Let's Encrypt
	Email string `yaml:"email" json:"email"`
	// Enable automatic HTTPS
	AutoHTTPS bool `yaml:"auto_https" json:"auto_https"`
	// Reload controls retry/backoff behavior for reload operations (primarily Admin API).
	Reload CaddyReloadConfig `yaml:"reload" json:"reload"`
	// Logging controls per-site access logging in the generated Caddyfile.
	Logging CaddyLoggingConfig `yaml:"logging" json:"logging"`
}

// CaddyReloadConfig controls reload retries/backoff.
type CaddyReloadConfig struct {
	Retries        int           `yaml:"retries" json:"retries"`
	BackoffMin     time.Duration `yaml:"backoff_min" json:"backoff_min"`
	BackoffMax     time.Duration `yaml:"backoff_max" json:"backoff_max"`
	JitterFraction float64       `yaml:"jitter_fraction" json:"jitter_fraction"`
	AttemptTimeout time.Duration `yaml:"attempt_timeout" json:"attempt_timeout"`
}

// CaddyLoggingConfig controls Caddyfile `log` directive output for each site.
type CaddyLoggingConfig struct {
	// Output: "stdout", "stderr", or "file"
	Output string `yaml:"output" json:"output"`
	// File is used when Output == "file"
	File string `yaml:"file" json:"file"`
	// Format: "console" or "json"
	Format string `yaml:"format" json:"format"`
	// Level: "DEBUG", "INFO", "WARN", "ERROR" (Caddy accepts various levels)
	Level string `yaml:"level" json:"level"`
}

// CaddyStatus represents the current status of Caddy
type CaddyStatus struct {
	Running     bool     `json:"running"`
	Version     string   `json:"version,omitempty"`
	ConfigValid bool     `json:"config_valid"`
	Routes      int      `json:"routes"`
	Domains     []string `json:"domains,omitempty"`
	Error       string   `json:"error,omitempty"`
	Mode        string   `json:"mode,omitempty"`
}

// CertificateInfo represents SSL certificate information
type CertificateInfo struct {
	Domain    string    `json:"domain"`
	Issuer    string    `json:"issuer"`
	NotBefore time.Time `json:"not_before"`
	NotAfter  time.Time `json:"not_after"`
	DaysLeft  int       `json:"days_left"`
	AutoRenew bool      `json:"auto_renew"`
}
