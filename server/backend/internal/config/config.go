package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

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

type AuthConfig struct {
	JWTSecret  string `mapstructure:"jwt_secret"` // Auto-generated if empty
	SecretFile string `mapstructure:"secret_file"`
	CSRFSecret string `mapstructure:"csrf_secret"`
}

type ServerConfig struct {
	Host string `mapstructure:"host"`
	Port int    `mapstructure:"port"`
	Mode string `mapstructure:"mode"`
}

type DatabaseConfig struct {
	Path string `mapstructure:"path"`
}

type AppsConfig struct {
	DataPath    string `mapstructure:"data_path"`
	CatalogPath string `mapstructure:"catalog_path"`
}

type DockerConfig struct {
	Method     string        `mapstructure:"method"` // auto, socket, tcp, ssh
	SocketPath string        `mapstructure:"socket_path"`
	TCP        TCPConfig     `mapstructure:"tcp"`
	SSH        SSHConfig     `mapstructure:"ssh"`
	Timeout    time.Duration `mapstructure:"timeout"`
}

type TCPConfig struct {
	Host     string `mapstructure:"host"`
	Port     int    `mapstructure:"port"`
	UseTLS   bool   `mapstructure:"use_tls"`
	CertPath string `mapstructure:"cert_path"`
}

type SSHConfig struct {
	Host    string `mapstructure:"host"`
	User    string `mapstructure:"user"`
	KeyPath string `mapstructure:"key_path"`
}

type LoggingConfig struct {
	Level string `mapstructure:"level"`
	Path  string `mapstructure:"path"`
}

type CORSConfig struct {
	AllowedOrigins []string `mapstructure:"allowed_origins"`
}

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
}

// CaddyConfig mirrors the network.CaddyConfig but avoids import cycles
type CaddyConfig struct {
	AdminAPI      string `mapstructure:"admin_api"`
	ConfigPath    string `mapstructure:"config_path"`
	DefaultDomain string `mapstructure:"default_domain"`
	Email         string `mapstructure:"email"`
	AutoHTTPS     bool   `mapstructure:"auto_https"`
}

var globalConfig *Config
var configFilePath string

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

func Get() *Config {
	return globalConfig
}

// ConfigPath returns the last-loaded config path, if known.
func ConfigPath() string {
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
	if err := os.MkdirAll(strings.TrimSuffix(path, "/libreserv.yaml"), 0o755); err != nil {
		// best effort; ignore if fails
	}
	return os.WriteFile(path, data, 0o600)
}
