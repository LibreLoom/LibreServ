package config

import (
	"strings"

	"github.com/spf13/viper"
)

// C is the loaded configuration.
var C Config

type Config struct {
	Server     ServerConfig     `mapstructure:"server"`
	Database   DatabaseConfig   `mapstructure:"database"`
	DataDir    string           `mapstructure:"data_dir"`
	Cloudflare CloudflareConfig `mapstructure:"cloudflare"`
	Stripe     StripeConfig     `mapstructure:"stripe"`
	Backup     BackupConfig     `mapstructure:"backup"`
}

type ServerConfig struct {
	Address    string `mapstructure:"address"`
	Port       int    `mapstructure:"port"`
	BaseURL    string `mapstructure:"base_url"`
	PublicZone string `mapstructure:"public_zone"`
	AdminToken string `mapstructure:"admin_token"`
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
	SecretKey     string `mapstructure:"secret_key"`
	WebhookSecret string `mapstructure:"webhook_secret"`
	PriceID       string `mapstructure:"price_id"`
	Enabled       bool   `mapstructure:"enabled"`
}

type BackupConfig struct {
	Driver           string `mapstructure:"driver"`
	B2AccountID      string `mapstructure:"b2_account_id"`
	B2ApplicationKey string `mapstructure:"b2_application_key"`
	Bucket           string `mapstructure:"bucket"`
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
	viper.SetDefault("server.base_url", "https://connect.luna.libreserv.org")
	viper.SetDefault("server.public_zone", "luna.servers.libreloom.org")
	viper.SetDefault("database.path", "dev/luna-connect.db")
	viper.SetDefault("data_dir", "dev/data")
	viper.SetDefault("backup.driver", "local")
}

func (c CloudflareConfig) Ready() bool {
	return c.AccountID != "" && c.APIToken != "" && c.ZoneID != ""
}

func (c StripeConfig) Ready() bool {
	return c.Enabled && c.SecretKey != ""
}
