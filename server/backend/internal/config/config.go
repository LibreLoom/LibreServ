// Package config manages LibreServ application configuration.
//
// Configuration values are resolved in this order (later wins):
//
//  1. Code defaults    — viper.SetDefault() in LoadConfig()
//  2. Config file     — /etc/libreserv/libreserv.yaml (or --config path)
//  3. Environment     — LIBRESERV_<KEY> (e.g. LIBRESERV_SERVER_PORT)
//  4. Database         — app_settings table overrides for DB-backed keys
//
// DB-backed keys (logging.level, smtp.*, server.mode, cors.allowed_origins,
// network.caddy.mode/default_domain/email/auto_https) are managed via the
// Settings UI. Editing these in the config file has no effect after first boot.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// Config holds application configuration values.
type Config struct {
	Server   ServerConfig   `mapstructure:"server" yaml:"server"`
	Database DatabaseConfig `mapstructure:"database" yaml:"database"`
	Auth     AuthConfig     `mapstructure:"auth" yaml:"auth"`
	Apps     AppsConfig     `mapstructure:"apps" yaml:"apps"`
	Docker   DockerConfig   `mapstructure:"docker" yaml:"docker"`
	Logging  LoggingConfig  `mapstructure:"logging" yaml:"logging"`
	Network  NetworkConfig  `mapstructure:"network" yaml:"network"`
	CORS     CORSConfig     `mapstructure:"cors" yaml:"cors"`
	License  LicenseConfig  `mapstructure:"license" yaml:"license"`
	SMTP     SMTPConfig     `mapstructure:"smtp" yaml:"smtp"`
	Notify   Notifications  `mapstructure:"notify" yaml:"notify"`
	Updates  UpdatesConfig  `mapstructure:"updates" yaml:"updates"`
}

// AuthConfig holds auth-related settings.
type AuthConfig struct {
	JWTSecret  string `mapstructure:"jwt_secret" yaml:"jwt_secret"`
	SecretFile string `mapstructure:"secret_file" yaml:"secret_file"`
	CSRFSecret string `mapstructure:"csrf_secret" yaml:"csrf_secret"`
}

// ServerConfig defines HTTP server settings.
type ServerConfig struct {
	Host string `mapstructure:"host" yaml:"host"`
	Port int    `mapstructure:"port" yaml:"port"`
	Mode string `mapstructure:"mode" yaml:"mode"`
}

// DatabaseConfig defines database settings.
type DatabaseConfig struct {
	Path string `mapstructure:"path" yaml:"path"`
}

// RepoConfig defines a git repository source for apps.
type RepoConfig struct {
	URL      string `mapstructure:"url" yaml:"url"`
	Branch   string `mapstructure:"branch" yaml:"branch"`
	Enabled  bool   `mapstructure:"enabled" yaml:"enabled"`
	Priority int    `mapstructure:"priority" yaml:"priority"`
}

// AppsConfig defines app catalog and data paths.
type AppsConfig struct {
	DataPath         string       `mapstructure:"data_path" yaml:"data_path"`
	CatalogPath      string       `mapstructure:"catalog_path" yaml:"catalog_path"`
	Repos            []RepoConfig `mapstructure:"repos" yaml:"repos"`
	RepoPullInterval string       `mapstructure:"repo_pull_interval" yaml:"repo_pull_interval"`
}

// UpdatesConfig defines platform update source settings.
type UpdatesConfig struct {
	BaseURL string `mapstructure:"base_url" yaml:"base_url"`
	Owner   string `mapstructure:"owner" yaml:"owner"`
	Repo    string `mapstructure:"repo" yaml:"repo"`
}

// DockerConfig defines Docker connection settings.
type DockerConfig struct {
	Method     string        `mapstructure:"method" yaml:"method"`
	SocketPath string        `mapstructure:"socket_path" yaml:"socket_path"`
	TCP        TCPConfig     `mapstructure:"tcp" yaml:"tcp"`
	SSH        SSHConfig     `mapstructure:"ssh" yaml:"ssh"`
	Timeout    time.Duration `mapstructure:"timeout" yaml:"timeout"`
}

// TCPConfig defines TCP Docker connection settings.
type TCPConfig struct {
	Host     string `mapstructure:"host" yaml:"host"`
	Port     int    `mapstructure:"port" yaml:"port"`
	UseTLS   bool   `mapstructure:"use_tls" yaml:"use_tls"`
	CertPath string `mapstructure:"cert_path" yaml:"cert_path"`
}

// SSHConfig defines SSH Docker connection settings.
type SSHConfig struct {
	Host    string `mapstructure:"host" yaml:"host"`
	User    string `mapstructure:"user" yaml:"user"`
	KeyPath string `mapstructure:"key_path" yaml:"key_path"`
}

// LoggingConfig defines logging settings.
type LoggingConfig struct {
	Level string `mapstructure:"level" yaml:"level"`
	Path  string `mapstructure:"path" yaml:"path"`
}

// CORSConfig defines CORS settings.
type CORSConfig struct {
	AllowedOrigins []string `mapstructure:"allowed_origins" yaml:"allowed_origins"`
}

// LicenseConfig defines license validation settings.
type LicenseConfig struct {
	EntitlementFile string `mapstructure:"entitlement_file" yaml:"entitlement_file"`
	PublicKeyFile   string `mapstructure:"public_key_file" yaml:"public_key_file"`
}

// SMTPConfig holds outbound email settings.
type SMTPConfig struct {
	Host       string `mapstructure:"host" yaml:"host"`
	Port       int    `mapstructure:"port" yaml:"port"`
	Username   string `mapstructure:"username" yaml:"username"`
	Password   string `mapstructure:"password" yaml:"password"`
	From       string `mapstructure:"from" yaml:"from"`
	UseTLS     bool   `mapstructure:"use_tls" yaml:"use_tls"`
	SkipVerify bool   `mapstructure:"skip_verify" yaml:"skip_verify"`
}

// Notifications holds email notification settings.
type Notifications struct {
	Enabled           bool     `mapstructure:"enabled" yaml:"enabled"`
	SupportRecipients []string `mapstructure:"support_recipients" yaml:"support_recipients"`
	SupportSubject    string   `mapstructure:"support_subject" yaml:"support_subject"`
	SupportBody       string   `mapstructure:"support_body" yaml:"support_body"`
	WelcomeSubject    string   `mapstructure:"welcome_subject" yaml:"welcome_subject"`
	WelcomeBody       string   `mapstructure:"welcome_body" yaml:"welcome_body"`
}

// NetworkConfig holds reverse proxy settings (Caddy)
type NetworkConfig struct {
	Caddy CaddyConfig `mapstructure:"caddy" yaml:"caddy"`
	ACME  ACMEConfig  `mapstructure:"acme" yaml:"acme"`
	DNS   DNSConfig   `mapstructure:"dns" yaml:"dns"`
}

// DNSConfig holds DNS provider settings for domain record management.
type DNSConfig struct {
	Provider string `mapstructure:"provider" yaml:"provider"`
	APIToken string `mapstructure:"api_token" yaml:"api_token"`
}

// ACMEConfig defines ACME-related settings.
type ACMEConfig struct {
	External ExternalACMEConfig `mapstructure:"external" yaml:"external"`
}

// ExternalACMEConfig holds external ACME issuer settings.
type ExternalACMEConfig struct {
	Enabled     bool              `mapstructure:"enabled" yaml:"enabled"`
	UseDocker   bool              `mapstructure:"use_docker" yaml:"use_docker"`
	DockerImage string            `mapstructure:"docker_image" yaml:"docker_image"`
	DataPath    string            `mapstructure:"data_path" yaml:"data_path"`
	DNSProvider string            `mapstructure:"dns_provider" yaml:"dns_provider"`
	DNSEnv      map[string]string `mapstructure:"dns_env" yaml:"dns_env"`
	Email       string            `mapstructure:"email" yaml:"email"`
	Staging     bool              `mapstructure:"staging" yaml:"staging"`
	CADirURL    string            `mapstructure:"ca_dir_url" yaml:"ca_dir_url"`
	KeyType     string            `mapstructure:"key_type" yaml:"key_type"`
	CertsPath   string            `mapstructure:"certs_path" yaml:"certs_path"`
}

type CaddyConfig struct {
	Mode          string         `mapstructure:"mode" yaml:"mode"`
	AdminAPI      string         `mapstructure:"admin_api" yaml:"admin_api"`
	ConfigPath    string         `mapstructure:"config_path" yaml:"config_path"`
	CertsPath     string         `mapstructure:"certs_path" yaml:"certs_path"`
	DefaultDomain string         `mapstructure:"default_domain" yaml:"default_domain"`
	Email         string         `mapstructure:"email" yaml:"email"`
	AutoHTTPS     bool           `mapstructure:"auto_https" yaml:"auto_https"`
	Reload        CaddyReload    `mapstructure:"reload" yaml:"reload"`
	Logging       CaddyLogConfig `mapstructure:"logging" yaml:"logging"`
}

// CaddyReload defines retry settings for Caddy reloads.
type CaddyReload struct {
	Retries        int           `mapstructure:"retries" yaml:"retries"`
	BackoffMin     time.Duration `mapstructure:"backoff_min" yaml:"backoff_min"`
	BackoffMax     time.Duration `mapstructure:"backoff_max" yaml:"backoff_max"`
	JitterFraction float64       `mapstructure:"jitter_fraction" yaml:"jitter_fraction"`
	AttemptTimeout time.Duration `mapstructure:"attempt_timeout" yaml:"attempt_timeout"`
}

// CaddyLogConfig defines Caddy logging settings.
type CaddyLogConfig struct {
	Output string `mapstructure:"output" yaml:"output"`
	File   string `mapstructure:"file" yaml:"file"`
	Format string `mapstructure:"format" yaml:"format"`
	Level  string `mapstructure:"level" yaml:"level"`
}

var globalConfig *Config
var configFilePath string

// SetDefaults registers all code defaults on the given viper instance.
// This is exported so subcommands can reuse the same defaults without duplication.
func SetDefaults(v *viper.Viper) {
	v.SetDefault("server.host", "0.0.0.0")
	v.SetDefault("server.port", 8080)
	v.SetDefault("server.mode", "production")
	v.SetDefault("database.path", "/var/lib/libreserv/libreserv.db")
	v.SetDefault("apps.data_path", "/var/lib/libreserv/apps")
	v.SetDefault("apps.catalog_path", "/opt/libreserv/catalog")
	v.SetDefault("apps.repo_pull_interval", "6h")
	v.SetDefault("updates.base_url", "https://gt.plainskill.net/api/v1")
	v.SetDefault("updates.owner", "libreloom")
	v.SetDefault("updates.repo", "libreserv")
	v.SetDefault("docker.method", "auto")
	v.SetDefault("docker.timeout", "30s")
	v.SetDefault("logging.level", "info")
	v.SetDefault("logging.path", "/var/log/libreserv/libreserv.log")
	v.SetDefault("smtp.port", 587)
	v.SetDefault("network.caddy.mode", "disabled")
	v.SetDefault("network.caddy.admin_api", "localhost:2019")
	v.SetDefault("network.caddy.config_path", "/etc/libreserv/caddy/Caddyfile")
	v.SetDefault("network.caddy.certs_path", "/etc/libreserv/caddy/certs")
	v.SetDefault("network.caddy.auto_https", false)
	v.SetDefault("network.caddy.reload.retries", 5)
	v.SetDefault("network.caddy.reload.backoff_min", "1s")
	v.SetDefault("network.caddy.reload.backoff_max", "30s")
	v.SetDefault("network.caddy.reload.jitter_fraction", 0.1)
	v.SetDefault("network.caddy.reload.attempt_timeout", "10s")
	v.SetDefault("network.caddy.logging.output", "stdout")
	v.SetDefault("network.caddy.logging.format", "console")
}

// LoadConfig loads configuration from disk and environment.
func LoadConfig(path string) error {
	v := viper.New()

	if path != "" {
		v.SetConfigFile(path)
	} else {
		v.SetConfigName("libreserv")
		v.SetConfigType("yaml")
		v.AddConfigPath("./configs")
		v.AddConfigPath("/etc/libreserv")
		v.AddConfigPath(".")
	}

	v.SetEnvPrefix("LIBRESERV")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	SetDefaults(v)

	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return err
		}
	}

	var c Config
	if err := v.Unmarshal(&c); err != nil {
		return err
	}

	globalConfig = &c
	configFilePath = v.ConfigFileUsed()
	if configFilePath == "" {
		configFilePath = path
	}
	return nil
}

// Get returns the currently loaded config.
func Get() *Config {
	return globalConfig
}

// Path returns the last-loaded config path, if known.
func Path() string {
	return configFilePath
}

// SaveConfig writes the current config to disk. If path is empty, uses the last-loaded config path.
func SaveConfig(path string) error {
	if globalConfig == nil {
		return fmt.Errorf("config not loaded")
	}
	if path == "" {
		path = configFilePath
	}
	if path == "" {
		return fmt.Errorf("config path unknown; please provide a path")
	}
	data, err := yaml.Marshal(globalConfig)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create config directory %q: %w", dir, err)
		}
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write config %q: %w", path, err)
	}
	return nil
}

// IsWritableFilePath reports whether a file path can be written to by the current process.
// - If the file exists, it checks if it can be opened for writing (without truncation).
// - If the file doesn't exist, it checks whether the parent directory can be created and written to.
func IsWritableFilePath(path string) (bool, error) {
	if path == "" {
		return false, nil
	}

	if st, err := os.Stat(path); err == nil {
		if st.IsDir() {
			return false, nil
		}
		// Fast path: if owner write bit is missing, treat as non-writable without touching the file.
		if st.Mode().Perm()&0o200 == 0 {
			return false, nil
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			if errors.Is(err, os.ErrPermission) {
				return false, nil
			}
			return false, err
		}
		_ = f.Close()
		return true, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}

	// File doesn't exist: check the directory is creatable/writable.
	dir := filepath.Dir(path)
	if dir == "" || dir == "." {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return false, nil
		}
		return false, err
	}
	tmp, err := os.CreateTemp(dir, ".libreserv-writecheck-*")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return false, nil
		}
		return false, err
	}
	name := tmp.Name()
	_ = tmp.Close()
	_ = os.Remove(name)
	return true, nil
}

// SetTestConfig sets the global config for testing purposes.
// This should only be used in test files.
func SetTestConfig(cfg *Config) {
	globalConfig = cfg
}
