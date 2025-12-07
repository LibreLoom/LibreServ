package config

import (
	"strings"
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	Server   ServerConfig   `mapstructure:"server"`
	Database DatabaseConfig `mapstructure:"database"`
	Auth     AuthConfig     `mapstructure:"auth"`
	Apps     AppsConfig     `mapstructure:"apps"`
	Docker   DockerConfig   `mapstructure:"docker"`
	Logging  LoggingConfig  `mapstructure:"logging"`
}

type AuthConfig struct {
	JWTSecret string `mapstructure:"jwt_secret"` // Auto-generated if empty
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

var globalConfig *Config

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
	return nil
}

func Get() *Config {
	return globalConfig
}
