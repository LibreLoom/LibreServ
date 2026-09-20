package config

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/spf13/viper"
)

// C holds the parsed application configuration.
var C Config

// Config is the top-level application configuration.
type Config struct {
	Server    ServerConfig    `mapstructure:"server" yaml:"server"`
	Database  DatabaseConfig  `mapstructure:"database" yaml:"database"`
	Auth      AuthConfig      `mapstructure:"auth" yaml:"auth"`
	Stripe    StripeConfig    `mapstructure:"stripe" yaml:"stripe"`
	SMTP      SMTPConfig      `mapstructure:"smtp" yaml:"smtp"`
	DNS       DNSConfig       `mapstructure:"dns" yaml:"dns"`
	Inference InferenceConfig `mapstructure:"inference" yaml:"inference"`
	Backup    BackupConfig    `mapstructure:"backup" yaml:"backup"`
	Tunnel    TunnelConfig    `mapstructure:"tunnel" yaml:"tunnel"`
	Web       WebConfig       `mapstructure:"web" yaml:"web"`
	Scheduler SchedulerConfig `mapstructure:"scheduler" yaml:"scheduler"`
	Purchase  PurchaseConfig  `mapstructure:"purchase" yaml:"purchase"`
}

// PurchaseConfig controls domain purchase behavior.
// Mock bypasses Stripe and Cloudflare Registrar so the full purchase flow can
// be walked end-to-end without real payment or registration (test/dev only).
type PurchaseConfig struct {
	MockDomain bool `mapstructure:"mock_domain" yaml:"mock_domain"`
}

type SchedulerConfig struct {
	DomainSyncInterval string `mapstructure:"domain_sync_interval" yaml:"domain_sync_interval"`
}

type ServerConfig struct {
	Address string `mapstructure:"address" yaml:"address"`
	Port    int    `mapstructure:"port" yaml:"port"`
	BaseURL string `mapstructure:"base_url" yaml:"base_url"`
}

type DatabaseConfig struct {
	URL string `mapstructure:"url" yaml:"url"`
}

type AuthConfig struct {
	DeviceTokenSecret   string `mapstructure:"device_token_secret" yaml:"device_token_secret"`
	AdminTokenSecret    string `mapstructure:"admin_token_secret" yaml:"admin_token_secret"`
	CustomerTokenSecret string `mapstructure:"customer_token_secret" yaml:"customer_token_secret"`
	SessionTTLHours     int    `mapstructure:"session_ttl_hours" yaml:"session_ttl_hours"`
	// AdminSeedToken authorizes POST /admin/seed, which creates the very first
	// admin account. When empty, seeding is only accepted from loopback.
	AdminSeedToken string `mapstructure:"admin_seed_token" yaml:"admin_seed_token"`
}

type StripeConfig struct {
	SecretKey     string `mapstructure:"secret_key" yaml:"secret_key"`
	WebhookSecret string `mapstructure:"webhook_secret" yaml:"webhook_secret"`
	Enabled       bool   `mapstructure:"enabled" yaml:"enabled"`
	PriceFree     string `mapstructure:"price_free" yaml:"price_free"`
	PriceLite     string `mapstructure:"price_lite" yaml:"price_lite"`
	PriceOne      string `mapstructure:"price_one" yaml:"price_one"`
}

type SMTPConfig struct {
	Host      string `mapstructure:"host" yaml:"host"`
	Port      int    `mapstructure:"port" yaml:"port"`
	Username  string `mapstructure:"username" yaml:"username"`
	Password  string `mapstructure:"password" yaml:"password"`
	From      string `mapstructure:"from" yaml:"from"`
	UseTLS    bool   `mapstructure:"use_tls" yaml:"use_tls"`
	RelayAddr string `mapstructure:"relay_addr" yaml:"relay_addr"`
	// RelayPublicHost is the hostname devices are told to connect to for the
	// SMTP relay (must be a DNS-only record, not Cloudflare-proxied).
	RelayPublicHost string `mapstructure:"relay_public_host" yaml:"relay_public_host"`
}

type DNSConfig struct {
	Provider    string   `mapstructure:"provider" yaml:"provider"`
	APIToken    string   `mapstructure:"api_token" yaml:"api_token"`
	Zone        string   `mapstructure:"zone" yaml:"zone"`
	Nameservers []string `mapstructure:"nameservers" yaml:"nameservers"`
}

type InferenceConfig struct {
	Provider string `mapstructure:"provider" yaml:"provider"`
	BaseURL  string `mapstructure:"base_url" yaml:"base_url"`
	APIKey   string `mapstructure:"api_key" yaml:"api_key"`
	Enabled  bool   `mapstructure:"enabled" yaml:"enabled"`
}

type BackupConfig struct {
	Provider     string `mapstructure:"provider" yaml:"provider"`
	Endpoint     string `mapstructure:"endpoint" yaml:"endpoint"`
	AccessKey    string `mapstructure:"access_key" yaml:"access_key"`
	SecretKey    string `mapstructure:"secret_key" yaml:"secret_key"`
	BucketPrefix string `mapstructure:"bucket_prefix" yaml:"bucket_prefix"`
}

type TunnelConfig struct {
	Provider  string `mapstructure:"provider" yaml:"provider"`
	APIToken  string `mapstructure:"api_token" yaml:"api_token"`
	AccountID string `mapstructure:"account_id" yaml:"account_id"`
}
type WebConfig struct {
	CustomerDir string `mapstructure:"customer_dir" yaml:"customer_dir"`
	AdminDir    string `mapstructure:"admin_dir" yaml:"admin_dir"`
}

func Load(path string) error {
	v := viper.New()
	v.SetEnvPrefix("CONNECT")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	// Defaults
	SetDefaults(v)

	if path != "" {
		v.SetConfigFile(path)
		if err := v.ReadInConfig(); err != nil {
			return fmt.Errorf("read config: %w", err)
		}
		slog.Info("loaded config", "file", v.ConfigFileUsed())
	}

	if err := v.Unmarshal(&C); err != nil {
		return fmt.Errorf("unmarshal config: %w", err)
	}

	return nil
}

func SetDefaults(v *viper.Viper) {
	v.SetDefault("server.address", "")
	v.SetDefault("server.port", 8080)
	v.SetDefault("database.url", "postgres://localhost:5432/libreserv_connect?sslmode=disable")
	v.SetDefault("auth.session_ttl_hours", 168)
	v.SetDefault("auth.admin_seed_token", "")
	v.SetDefault("web.customer_dir", "web/customer/dist")
	v.SetDefault("web.admin_dir", "web/admin/dist")
	v.SetDefault("scheduler.domain_sync_interval", "6h")
	v.SetDefault("purchase.mock_domain", false)
}

// CookieSecure is true when the portal is served over HTTPS (base_url).
// Session cookies then set the Secure attribute.
func CookieSecure() bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(C.Server.BaseURL)), "https://")
}
