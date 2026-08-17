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
	Runtime  RuntimeConfig  `mapstructure:"runtime" yaml:"runtime"`
	Logging  LoggingConfig  `mapstructure:"logging" yaml:"logging"`
	Network  NetworkConfig  `mapstructure:"network" yaml:"network"`
	CORS     CORSConfig     `mapstructure:"cors" yaml:"cors"`
	SMTP     SMTPConfig     `mapstructure:"smtp" yaml:"smtp"`
	Notify   Notifications  `mapstructure:"notify" yaml:"notify"`
	Updates  UpdatesConfig  `mapstructure:"updates" yaml:"updates"`
	Support  SupportConfig  `mapstructure:"support" yaml:"support"`
	Connect  ConnectConfig  `mapstructure:"connect" yaml:"connect"`
}

// AuthConfig holds auth-related settings.
type AuthConfig struct {
	JWTSecret          string        `mapstructure:"jwt_secret" yaml:"jwt_secret"`
	CSRFSecret         string        `mapstructure:"csrf_secret" yaml:"csrf_secret"`
	CloudEncryptionKey string        `mapstructure:"cloud_encryption_key" yaml:"cloud_encryption_key"`
	MFA                AuthMFAConfig `mapstructure:"mfa" yaml:"mfa"`
}

// AuthMFAConfig holds multi-factor-auth settings. TOTPEncryptionKey (AES-GCM)
// wraps TOTP secrets at rest; if empty, TOTP enrollment fails closed.
// WebAuthn is consumed by the internal/auth/webauthn package (wired in main.go).
type AuthMFAConfig struct {
	TOTPEncryptionKey string         `mapstructure:"totp_encryption_key" yaml:"totp_encryption_key"`
	WebAuthn          WebAuthnConfig `mapstructure:"webauthn" yaml:"webauthn"`
}

// WebAuthnConfig holds Relying-Party settings for passkey/security-key ceremonies.
type WebAuthnConfig struct {
	RPID          string   `mapstructure:"rp_id" yaml:"rp_id"`
	RPDisplayName string   `mapstructure:"rp_display_name" yaml:"rp_display_name"`
	Origins       []string `mapstructure:"origins" yaml:"origins"`
	Timeout       string   `mapstructure:"timeout" yaml:"timeout"`
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
	Username string `mapstructure:"username" yaml:"username"`
	Password string `mapstructure:"password" yaml:"password"`
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

// SupportConfig defines AI support agent settings.
type SupportConfig struct {
	InferenceBaseURL string                  `mapstructure:"inference_base_url" yaml:"inference_base_url"`
	Plans            []SupportPlan           `mapstructure:"plans" yaml:"plans"`
	Agent            AgentConfig             `mapstructure:"agent" yaml:"agent"`
	Pricing          map[string]ModelPricing `mapstructure:"pricing" yaml:"pricing"`
	BYOKEnabled      bool                    `mapstructure:"byok_enabled" yaml:"byok_enabled"`
	UserAPIKey       string                  `mapstructure:"user_api_key" yaml:"user_api_key"`
	UserBaseURL      string                  `mapstructure:"user_base_url" yaml:"user_base_url"`
	UserAPIFormat    string                  `mapstructure:"user_api_format" yaml:"user_api_format"`
	SelfHealing      bool                    `mapstructure:"self_healing" yaml:"self_healing"`
}

type ConnectConfig struct {
	Token         string            `mapstructure:"token" yaml:"token"`
	APIURL        string            `mapstructure:"api_url" yaml:"api_url"`
	ServiceStates map[string]string `mapstructure:"service_states" yaml:"service_states"`
}

type ModelPricing struct {
	InputPer1M  float64 `mapstructure:"input_per_1m" yaml:"input_per_1m"`
	OutputPer1M float64 `mapstructure:"output_per_1m" yaml:"output_per_1m"`
	CachePer1M  float64 `mapstructure:"cache_per_1m" yaml:"cache_per_1m"`
}

// SupportPlan defines a support subscription tier.
type SupportPlan struct {
	ID                 string  `mapstructure:"id" yaml:"id"`
	Name               string  `mapstructure:"name" yaml:"name"`
	PriceMonthly       int     `mapstructure:"price_monthly" yaml:"price_monthly"`
	CreditCapUSD       float64 `mapstructure:"credit_cap_usd" yaml:"credit_cap_usd"`
	HumanEscalation    bool    `mapstructure:"human_escalation" yaml:"human_escalation"`
	SelfHealing        bool    `mapstructure:"self_healing" yaml:"self_healing"`
	SelfHealingDefault bool    `mapstructure:"self_healing_default" yaml:"self_healing_default"`
}

// AgentConfig defines agent loop parameters.
//
// The Sandbox field controls the OS-level execution boundary for the bash tool.
// See internal/agent/sandbox for the backends. When Sandbox.Mode is empty or
// "auto", bubblewrap is used when available and the tool otherwise falls back to
// unsandboxed execution (with a warning). Set Mode to "bwrap" to fail closed
// when bubblewrap is missing, or "off" to disable the sandbox entirely.
type AgentConfig struct {
	MainModel     string        `mapstructure:"main_model" yaml:"main_model"`
	ReviewModel   string        `mapstructure:"review_model" yaml:"review_model"`
	SummaryModel  string        `mapstructure:"summary_model" yaml:"summary_model"`
	ReviewEnabled bool          `mapstructure:"review_enabled" yaml:"review_enabled"`
	SystemPrompt  string        `mapstructure:"system_prompt" yaml:"system_prompt"`
	MaxTurns      int           `mapstructure:"max_turns" yaml:"max_turns"`
	TurnTimeout   time.Duration `mapstructure:"turn_timeout" yaml:"turn_timeout"`
	DataDirs      []string      `mapstructure:"data_dirs" yaml:"data_dirs"`
	SystemPlanID  string        `mapstructure:"system_plan_id" yaml:"system_plan_id"`
	Sandbox       SandboxConfig `mapstructure:"sandbox" yaml:"sandbox"`
}

// SandboxConfig configures the OS boundary that runs agent shell commands.
type SandboxConfig struct {
	// Mode selects the backend: "auto" (default), "bwrap", or "off".
	Mode string `mapstructure:"mode" yaml:"mode"`
	// Workdirs are absolute host directories the agent may write to. Everything
	// else under / is mounted read-only inside the sandbox.
	Workdirs []string `mapstructure:"workdirs" yaml:"workdirs"`
	// Network controls outbound network egress from sandboxed commands. Defaults
	// to true because the agent needs it to reach the Podman socket and install
	// packages; set false to fully isolate networking.
	Network bool `mapstructure:"network" yaml:"network"`
}

// RuntimeConfig defines container runtime connection settings.
type RuntimeConfig struct {
	Method     string    `mapstructure:"method" yaml:"method"`
	SocketPath string    `mapstructure:"socket_path" yaml:"socket_path"`
	TCP        TCPConfig `mapstructure:"tcp" yaml:"tcp"`
	Binary     string    `mapstructure:"binary" yaml:"binary"`
}

// TCPConfig defines TCP container runtime connection settings.
type TCPConfig struct {
	Host     string `mapstructure:"host" yaml:"host"`
	Port     int    `mapstructure:"port" yaml:"port"`
	UseTLS   bool   `mapstructure:"use_tls" yaml:"use_tls"`
	CertPath string `mapstructure:"cert_path" yaml:"cert_path"`
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

// NetworkConfig holds reverse proxy settings (Caddy), mDNS, and tunnel.
type NetworkConfig struct {
	Caddy     CaddyConfig     `mapstructure:"caddy" yaml:"caddy"`
	MDNS      MDNSConfig      `mapstructure:"mdns" yaml:"mdns"`
	ACME      ACMEConfig      `mapstructure:"acme" yaml:"acme"`
	Tunnel    TunnelConfig    `mapstructure:"tunnel" yaml:"tunnel"`
	Bluetooth BluetoothConfig `mapstructure:"bluetooth" yaml:"bluetooth"`
}

// MDNSConfig holds mDNS advertisement settings.
type MDNSConfig struct {
	Enabled bool `mapstructure:"enabled" yaml:"enabled"`
}

// TunnelConfig holds tunnel service settings.
type TunnelConfig struct {
	Provider string `mapstructure:"provider" yaml:"provider"`
	Token    string `mapstructure:"token" yaml:"token"`
	Enabled  bool   `mapstructure:"enabled" yaml:"enabled"`
}

// BluetoothConfig holds BLE peripheral settings for the companion app.
type BluetoothConfig struct {
	Enabled bool `mapstructure:"enabled" yaml:"enabled"`
}

// ACMEConfig defines ACME-related settings.
type ACMEConfig struct {
	External ExternalACMEConfig `mapstructure:"external" yaml:"external"`
}

// ExternalACMEConfig holds external ACME issuer settings.
type ExternalACMEConfig struct {
	Enabled        bool              `mapstructure:"enabled" yaml:"enabled"`
	UsePodman      bool              `mapstructure:"use_podman" yaml:"use_podman"`
	ContainerImage string            `mapstructure:"container_image" yaml:"container_image"`
	DataPath       string            `mapstructure:"data_path" yaml:"data_path"`
	DNSProvider    string            `mapstructure:"dns_provider" yaml:"dns_provider"`
	DNSEnv         map[string]string `mapstructure:"dns_env" yaml:"dns_env"`
	Email          string            `mapstructure:"email" yaml:"email"`
	Staging        bool              `mapstructure:"staging" yaml:"staging"`
	CADirURL       string            `mapstructure:"ca_dir_url" yaml:"ca_dir_url"`
	KeyType        string            `mapstructure:"key_type" yaml:"key_type"`
	CertsPath      string            `mapstructure:"certs_path" yaml:"certs_path"`
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
	v.SetDefault("server.host", "127.0.0.1")
	v.SetDefault("server.port", 8080)
	v.SetDefault("server.mode", "production")
	v.SetDefault("database.path", "/var/lib/libreserv/libreserv.db")
	v.SetDefault("apps.data_path", "/var/lib/libreserv/apps")
	v.SetDefault("apps.catalog_path", "/opt/libreserv/catalog")
	v.SetDefault("apps.repo_pull_interval", "6h")
	v.SetDefault("apps.repos", []map[string]interface{}{
		{
			"url":     "https://gt.plainskill.net/LibreLoom/ServApps.git",
			"branch":  "main",
			"enabled": true,
		},
	})
	v.SetDefault("updates.base_url", "https://gt.plainskill.net/api/v1")
	v.SetDefault("updates.owner", "libreloom")
	v.SetDefault("updates.repo", "libreserv")
	v.SetDefault("runtime.method", "auto")
	v.SetDefault("runtime.binary", "podman")
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
	v.SetDefault("network.mdns.enabled", true)
	v.SetDefault("network.bluetooth.enabled", true)

	v.SetDefault("support.inference_base_url", "https://api.routing.run/v1")

	v.SetDefault("support.agent.max_turns", 10)
	v.SetDefault("support.agent.turn_timeout", "5m")
	v.SetDefault("support.agent.review_enabled", true)
	v.SetDefault("support.agent.system_plan_id", "basic")
	v.SetDefault("support.agent.data_dirs", []string{"/var/lib/libreserv", "/etc/libreserv"})
	// summary_model: optional model that summarizes the session so the review
	// model can judge tool calls with real context. Empty = use a truncated
	// transcript fallback (no extra LLM call).
	v.SetDefault("support.agent.summary_model", "")
	// Sandbox: bubblewrap when available, a writable set covering LibreServ data
	// and logs, and network enabled (needed for the Podman socket + packages).
	v.SetDefault("support.agent.sandbox.mode", "auto")
	v.SetDefault("support.agent.sandbox.workdirs", []string{"/var/lib/libreserv", "/var/log/libreserv"})
	v.SetDefault("support.agent.sandbox.network", true)

	v.SetDefault("connect.api_url", "https://connect.serv.libreloom.org")
	v.SetDefault("support.pricing.route/mimo-v2.5-pro.input_per_1m", 0.45)
	v.SetDefault("support.pricing.route/mimo-v2.5-pro.output_per_1m", 1.00)
	v.SetDefault("support.pricing.route/mimo-v2.5-pro.cache_per_1m", 0.10)
	v.SetDefault("support.pricing.route/kimi-k2.6.input_per_1m", 0.46)
	v.SetDefault("support.pricing.route/kimi-k2.6.output_per_1m", 2.00)
	v.SetDefault("support.pricing.route/kimi-k2.6.cache_per_1m", 0.10)
	v.SetDefault("support.pricing.route/deepseek-v4-pro.input_per_1m", 0.49)
	v.SetDefault("support.pricing.route/deepseek-v4-pro.output_per_1m", 0.74)
	v.SetDefault("support.pricing.route/deepseek-v4-pro.cache_per_1m", 0.003)
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

	if v.ConfigFileUsed() == "" {
		return fmt.Errorf("no config file found; copy configs/libreserv.yaml.example to configs/libreserv.yaml and adjust values")
	}

	var c Config
	if err := v.Unmarshal(&c); err != nil {
		return err
	}

	globalConfig = &c
	configFilePath = v.ConfigFileUsed()
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
