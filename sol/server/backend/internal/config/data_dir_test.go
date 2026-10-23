package config

import (
	"github.com/spf13/viper"
	"strings"
	"testing"
)

func TestTailscaleDataDirectoryDoesNotFollowDatabasePath(t *testing.T) {
	for _, dbPath := range []string{":memory:", "relative.db", "/elsewhere/sol.db"} {
		v := viper.New()
		SetDefaults(v)
		v.Set("database.path", dbPath)
		var cfg Config
		if err := v.Unmarshal(&cfg); err != nil {
			t.Fatal(err)
		}
		if cfg.Server.DataDir != "/var/lib/sol" {
			t.Fatalf("%s moved data to %s", dbPath, cfg.Server.DataDir)
		}
	}
	t.Setenv("SOL_SERVER_DATA_DIR", "/scratch/sol-data")
	v := viper.New()
	SetDefaults(v)
	v.SetEnvPrefix("SOL")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()
	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Server.DataDir != "/scratch/sol-data" {
		t.Fatalf("explicit data directory was ignored: %s", cfg.Server.DataDir)
	}
}
