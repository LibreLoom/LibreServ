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
	Crypto    CryptoConfig    `mapstructure:"crypto" yaml:"crypto"`
	SMTP      SMTPConfig      `mapstructure:"smtp" yaml:"smtp"`
	DNS       DNSConfig       `mapstructure:"dns" yaml:"dns"`
	Inference InferenceConfig `mapstructure:"inference" yaml:"inference"`
	Backup    BackupConfig    `mapstructure:"backup" yaml:"backup"`
	Tunnel    TunnelConfig    `mapstructure:"tunnel" yaml:"tunnel"`
}

type ServerConfig struct {
	Address string `mapstructure:"address" yaml:"address"`
	Port    int    `mapstructure:"port" yaml:"port"`
}

type DatabaseConfig struct {
	Path string `mapstructure:"path" yaml:"path"`
}

type AuthConfig struct {
	DeviceTokenSecret string `mapstructure:"device_token_secret" yaml:"device_token_secret"`
	AdminTokenSecret  string `mapstructure:"admin_token_secret" yaml:"admin_token_secret"`
	SessionTTLHours   int    `mapstructure:"session_ttl_hours" yaml:"session_ttl_hours"`
}

type StripeConfig struct {
	SecretKey     string `mapstructure:"secret_key" yaml:"secret_key"`
	WebhookSecret string `mapstructure:"webhook_secret" yaml:"webhook_secret"`
	Enabled       bool   `mapstructure:"enabled" yaml:"enabled"`
}

type CryptoConfig struct {
	Enabled      bool   `mapstructure:"enabled" yaml:"enabled"`
	BTCAddress   string `mapstructure:"btc_address" yaml:"btc_address"`
	ETHAddress   string `mapstructure:"eth_address" yaml:"eth_address"`
	ReconcileURL string `mapstructure:"reconcile_url" yaml:"reconcile_url"`
}

type SMTPConfig struct {
	Host     string `mapstructure:"host" yaml:"host"`
	Port     int    `mapstructure:"port" yaml:"port"`
	Username string `mapstructure:"username" yaml:"username"`
	Password string `mapstructure:"password" yaml:"password"`
	From     string `mapstructure:"from" yaml:"from"`
	UseTLS   bool   `mapstructure:"use_tls" yaml:"use_tls"`
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
	v.SetDefault("database.path", "connect.db")
	v.SetDefault("auth.session_ttl_hours", 168)
}
