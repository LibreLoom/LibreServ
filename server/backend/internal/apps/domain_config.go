package apps

// DomainConfig contains domain configuration for app installation
type DomainConfig struct {
	Subdomain string `json:"subdomain"`
	Domain    string `json:"domain"`
}
