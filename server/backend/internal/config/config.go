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
	Server   ServerConfig   `mapstructure:"server"`
	Database DatabaseConfig `mapstructure:"database"`
	Auth     AuthConfig     `mapstructure:"auth"`
	Apps     AppsConfig     `mapstructure:"apps"`
	Docker   DockerConfig   `mapstructure:"docker"`
	Logging  LoggingConfig  `mapstructure:"logging"`
	Network  NetworkConfig  `mapstructure:"network"`
	CORS     CORSConfig     `mapstructure:"cors"`
	License  LicenseConfig  `mapstructure:"license"`
	SMTP     SMTPConfig     `mapstructure:"smtp"`
	Notify   Notifications  `mapstructure:"notify"`
}

// AuthConfig holds auth-related settings.
type AuthConfig struct {
	JWTSecret  string `mapstructure:"jwt_secret"` // Auto-generated if empty
	SecretFile string `mapstructure:"secret_file"`
	CSRFSecret string `mapstructure:"csrf_secret"`
}

// ServerConfig defines HTTP server settings.
type ServerConfig struct {
	Host string `mapstructure:"host"`
	Port int    `mapstructure:"port"`
	Mode string `mapstructure:"mode"`
}

// DatabaseConfig defines database settings.
type DatabaseConfig struct {
	Path string `mapstructure:"path"`
}

// AppsConfig defines app catalog and data paths.
type AppsConfig struct {
	DataPath    string `mapstructure:"data_path" yaml:"data_path"`
	CatalogPath string `mapstructure:"catalog_path" yaml:"catalog_path"`
}

// DockerConfig defines Docker connection settings.
type DockerConfig struct {
	Method     string        `mapstructure:"method"` // auto, socket, tcp, ssh
	SocketPath string        `mapstructure:"socket_path"`
	TCP        TCPConfig     `mapstructure:"tcp"`
	SSH        SSHConfig     `mapstructure:"ssh"`
	Timeout    time.Duration `mapstructure:"timeout"`
}

// TCPConfig defines TCP Docker connection settings.
type TCPConfig struct {
	Host     string `mapstructure:"host"`
	Port     int    `mapstructure:"port"`
	UseTLS   bool   `mapstructure:"use_tls"`
	CertPath string `mapstructure:"cert_path"`
}

// SSHConfig defines SSH Docker connection settings.
type SSHConfig struct {
	Host    string `mapstructure:"host"`
	User    string `mapstructure:"user"`
	KeyPath string `mapstructure:"key_path"`
}

// LoggingConfig defines logging settings.
type LoggingConfig struct {
	Level string `mapstructure:"level"`
	Path  string `mapstructure:"path"`
}

// CORSConfig defines CORS settings.
type CORSConfig struct {
	AllowedOrigins []string `mapstructure:"allowed_origins"`
}

// LicenseConfig defines license validation settings.
type LicenseConfig struct {
	EntitlementFile string `mapstructure:"entitlement_file"`
	PublicKeyFile   string `mapstructure:"public_key_file"`
}

// SMTPConfig holds outbound email settings.
type SMTPConfig struct {
	Host       string `mapstructure:"host"`
	Port       int    `mapstructure:"port"`
	Username   string `mapstructure:"username"`
	Password   string `mapstructure:"password"`
	From       string `mapstructure:"from"`
	UseTLS     bool   `mapstructure:"use_tls"`
	SkipVerify bool   `mapstructure:"skip_verify"` // allow self-signed (dev)
}

// Notifications holds email notification settings.
type Notifications struct {
	Enabled           bool     `mapstructure:"enabled"`
	SupportRecipients []string `mapstructure:"support_recipients"`
	SupportSubject    string   `mapstructure:"support_subject"`
	SupportBody       string   `mapstructure:"support_body"`
	WelcomeSubject    string   `mapstructure:"welcome_subject"`
	WelcomeBody       string   `mapstructure:"welcome_body"`
}

// NetworkConfig holds reverse proxy settings (Caddy)
type NetworkConfig struct {
	Caddy CaddyConfig `mapstructure:"caddy"`
	ACME  ACMEConfig  `mapstructure:"acme"`
}

// ACMEConfig defines ACME-related settings.
type ACMEConfig struct {
	External ExternalACMEConfig `mapstructure:"external"`
}

// ExternalACMEConfig holds external ACME issuer settings.
type ExternalACMEConfig struct {
	Enabled     bool              `mapstructure:"enabled"`
	UseDocker   bool              `mapstructure:"use_docker"`
	DockerImage string            `mapstructure:"docker_image"`
	DataPath    string            `mapstructure:"data_path"`
	DNSProvider string            `mapstructure:"dns_provider"`
	DNSEnv      map[string]string `mapstructure:"dns_env"`
	Email       string            `mapstructure:"email"`
	Staging     bool              `mapstructure:"staging"`
	CADirURL    string            `mapstructure:"ca_dir_url"`
	KeyType     string            `mapstructure:"key_type"`
	// CertsPath is where the issued cert/key will be copied for Caddy to use.
	CertsPath string `mapstructure:"certs_path"`
}

// CaddyConfig mirrors the network.CaddyConfig but avoids import cycles
// CaddyConfig defines Caddy reverse proxy settings.
type CaddyConfig struct {
	Mode          string         `mapstructure:"mode"`
	AdminAPI      string         `mapstructure:"admin_api"`
	ConfigPath    string         `mapstructure:"config_path"`
	CertsPath     string         `mapstructure:"certs_path"`
	DefaultDomain string         `mapstructure:"default_domain"`
	Email         string         `mapstructure:"email"`
	AutoHTTPS     bool           `mapstructure:"auto_https"`
	Reload        CaddyReload    `mapstructure:"reload"`
	Logging       CaddyLogConfig `mapstructure:"logging"`
}

// CaddyReload defines retry settings for Caddy reloads.
type CaddyReload struct {
	Retries        int           `mapstructure:"retries"`
	BackoffMin     time.Duration `mapstructure:"backoff_min"`
	BackoffMax     time.Duration `mapstructure:"backoff_max"`
	JitterFraction float64       `mapstructure:"jitter_fraction"`
	AttemptTimeout time.Duration `mapstructure:"attempt_timeout"`
}

// CaddyLogConfig defines Caddy logging settings.
type CaddyLogConfig struct {
	Output string `mapstructure:"output"`
	File   string `mapstructure:"file"`
	Format string `mapstructure:"format"`
	Level  string `mapstructure:"level"`
}

var globalConfig *Config
var configFilePath string

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
