package config

import (
	"testing"

	"github.com/spf13/viper"
)

func TestExampleYAMLParsesSandbox(t *testing.T) {
	v := viper.New()
	SetDefaults(v)
	v.SetConfigType("yaml")
	v.SetConfigFile("../../configs/libreserv.yaml.example")
	if err := v.ReadInConfig(); err != nil {
		t.Fatalf("read example: %v", err)
	}
	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if cfg.Support.Agent.Sandbox.Mode != "auto" {
		t.Errorf("sandbox.mode = %q, want auto", cfg.Support.Agent.Sandbox.Mode)
	}
	if !cfg.Support.Agent.Sandbox.Network {
		t.Error("sandbox.network should default true from the example")
	}
	if len(cfg.Support.Agent.Sandbox.Workdirs) != 2 {
		t.Errorf("sandbox.workdirs len = %d, want 2", len(cfg.Support.Agent.Sandbox.Workdirs))
	}
}
