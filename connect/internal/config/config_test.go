package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/viper"
)

func TestSetDefaults(t *testing.T) {
	v := viper.New()
	SetDefaults(v)
	if v.GetInt("server.port") != 8080 ||
		v.GetInt("auth.session_ttl_hours") != 168 ||
		v.GetString("scheduler.domain_sync_interval") != "6h" {
		t.Fatalf("defaults not installed: %#v", v.AllSettings())
	}
}

func TestLoadDefaultsEnvironmentAndFile(t *testing.T) {
	old := C
	t.Cleanup(func() { C = old })

	t.Setenv("CONNECT_SERVER_PORT", "9191")
	if err := Load(""); err != nil {
		t.Fatalf("Load defaults: %v", err)
	}
	if C.Server.Port != 9191 || C.Auth.SessionTTLHours != 168 {
		t.Fatalf("loaded config = %#v", C)
	}

	path := filepath.Join(t.TempDir(), "connect.yaml")
	if err := os.WriteFile(path, []byte("server:\n  base_url: https://connect.example\npurchase:\n  mock_domain: true\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := Load(path); err != nil {
		t.Fatalf("Load file: %v", err)
	}
	if C.Server.BaseURL != "https://connect.example" || !C.Purchase.MockDomain {
		t.Fatalf("file config = %#v", C)
	}
	if err := Load(filepath.Join(t.TempDir(), "missing.yaml")); err == nil {
		t.Fatal("missing config did not fail")
	}
}

func TestCookieSecure(t *testing.T) {
	old := C.Server.BaseURL
	t.Cleanup(func() { C.Server.BaseURL = old })
	for url, want := range map[string]bool{
		"https://connect.example":    true,
		" HTTPS://CONNECT.EXAMPLE/ ": true,
		"http://connect.example":     false,
		"":                           false,
	} {
		C.Server.BaseURL = url
		if got := CookieSecure(); got != want {
			t.Errorf("CookieSecure with %q = %v", url, got)
		}
	}
}
