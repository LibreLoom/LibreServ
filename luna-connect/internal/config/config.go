package config

import (
	"os"
	"strings"

	"github.com/spf13/viper"
)

// C is the loaded configuration.
var C Config

type Config struct {
	Server     ServerConfig     `mapstructure:"server"`
	Auth       AuthConfig       `mapstructure:"auth"`
	Database   DatabaseConfig   `mapstructure:"database"`
	DataDir    string           `mapstructure:"data_dir"`
	Cloudflare CloudflareConfig `mapstructure:"cloudflare"`
	Stripe     StripeConfig     `mapstructure:"stripe"`
	Backup     BackupConfig     `mapstructure:"backup"`
	Mail       MailConfig       `mapstructure:"mail"`
}

type ServerConfig struct {
	Address    string `mapstructure:"address"`
	Port       int    `mapstructure:"port"`
	BaseURL    string `mapstructure:"base_url"`
	PublicZone string `mapstructure:"public_zone"`
	AdminToken string `mapstructure:"admin_token"`
	AtRestKey  string `mapstructure:"at_rest_key"`
	WebDir     string `mapstructure:"web_dir"`
}

// AuthConfig covers staff admin login (separate from customer accounts).
type AuthConfig struct {
	// AdminSeedToken gates POST /admin/seed when set (X-Seed-Token header).
	// Empty allows seed only from loopback.
	AdminSeedToken  string `mapstructure:"admin_seed_token"`
	SessionTTLHours int    `mapstructure:"session_ttl_hours"`
}

type DatabaseConfig struct {
	Path string `mapstructure:"path"`
}

type CloudflareConfig struct {
	AccountID string `mapstructure:"account_id"`
	APIToken  string `mapstructure:"api_token"`
	ZoneID    string `mapstructure:"zone_id"`
}

type StripeConfig struct {
	SecretKey      string `mapstructure:"secret_key"`
	PublishableKey string `mapstructure:"publishable_key"`
	WebhookSecret  string `mapstructure:"webhook_secret"`
	PriceID        string `mapstructure:"price_id"`
	Enabled        bool   `mapstructure:"enabled"`
}

type BackupConfig struct {
	Driver          string `mapstructure:"driver"`
	MaxObjectBytes  int64  `mapstructure:"max_object_bytes"`
	MaxAccountBytes int64  `mapstructure:"max_account_bytes"`
}

// MailConfig is server-only transactional mail (billing warnings).
type MailConfig struct {
	ResendAPIKey string `mapstructure:"resend_api_key"`
	From         string `mapstructure:"from"`
	BaseURL      string `mapstructure:"base_url"`
}

func Load(path string) error {
	viper.SetConfigFile(path)
	viper.SetEnvPrefix("LUNACONNECT")
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	viper.AutomaticEnv()
	setDefaults()
	if err := viper.ReadInConfig(); err != nil {
		_ = viper.Unmarshal(&C)
		return err
	}
	return viper.Unmarshal(&C)
}

func setDefaults() {
	viper.SetDefault("server.address", "0.0.0.0")
	viper.SetDefault("server.port", 8092)
	viper.SetDefault("server.base_url", "https://connect.luna.libreloom.org")
	viper.SetDefault("server.public_zone", "luna.servers.libreloom.org")
	viper.SetDefault("database.path", "dev/luna-connect.db")
	viper.SetDefault("data_dir", "dev/data")
	viper.SetDefault("backup.driver", "local")
	viper.SetDefault("server.web_dir", "web/dist")
	viper.SetDefault("auth.session_ttl_hours", 168)
	viper.SetDefault("mail.from", "Luna Connect <noreply@connect.luna.libreloom.org>")
}

func (c CloudflareConfig) Ready() bool {
	return c.AccountID != "" && c.APIToken != "" && c.ZoneID != ""
}

func (c StripeConfig) Ready() bool {
	return c.Enabled && c.SecretKey != ""
}

// DevMode is explicit local/dev only (LUNACONNECT_DEV=1/true/yes).
// stripe.enabled: false is not a production bypass by itself.
func DevMode() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("LUNACONNECT_DEV")))
	return v == "1" || v == "true" || v == "yes"
}

func CookieSecure() bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(C.Server.BaseURL)), "https://")
}
