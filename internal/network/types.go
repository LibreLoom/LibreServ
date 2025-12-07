package network

import (
	"time"
)

// Route represents a reverse proxy route
type Route struct {
	ID          string    `json:"id"`
	Subdomain   string    `json:"subdomain"`     // e.g., "nextcloud"
	Domain      string    `json:"domain"`        // e.g., "example.com"
	Backend     string    `json:"backend"`       // e.g., "http://localhost:8080"
	AppID       string    `json:"app_id"`        // Reference to the app
	SSL         bool      `json:"ssl"`           // Enable HTTPS
	Enabled     bool      `json:"enabled"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
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
	// AdminAPI is the URL for Caddy's admin API
	AdminAPI string `yaml:"admin_api" json:"admin_api"`
	// ConfigPath is the path to the Caddyfile
	ConfigPath string `yaml:"config_path" json:"config_path"`
	// DefaultDomain is the base domain for apps
	DefaultDomain string `yaml:"default_domain" json:"default_domain"`
	// Email for ACME/Let's Encrypt
	Email string `yaml:"email" json:"email"`
	// Enable automatic HTTPS
	AutoHTTPS bool `yaml:"auto_https" json:"auto_https"`
}

// CaddyStatus represents the current status of Caddy
type CaddyStatus struct {
	Running     bool     `json:"running"`
	Version     string   `json:"version,omitempty"`
	ConfigValid bool     `json:"config_valid"`
	Routes      int      `json:"routes"`
	Domains     []string `json:"domains,omitempty"`
	Error       string   `json:"error,omitempty"`
}

// CertificateInfo represents SSL certificate information
type CertificateInfo struct {
	Domain     string    `json:"domain"`
	Issuer     string    `json:"issuer"`
	NotBefore  time.Time `json:"not_before"`
	NotAfter   time.Time `json:"not_after"`
	DaysLeft   int       `json:"days_left"`
	AutoRenew  bool      `json:"auto_renew"`
}
