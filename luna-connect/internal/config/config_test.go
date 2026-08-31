package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFromExample(t *testing.T) {
	// Prefer the example shipped in-repo; fall back to a minimal temp file.
	candidates := []string{
		filepath.Join("..", "..", "configs", "luna-connect.yaml.example"),
		filepath.Join("..", "..", "configs", "luna-connect.yaml"),
	}
	path := ""
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			path = c
			break
		}
	}
	if path == "" {
		dir := t.TempDir()
		path = filepath.Join(dir, "cfg.yaml")
		content := []byte("server:\n  port: 8099\n  base_url: http://localhost:8099\n")
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := Load(path); err != nil {
		// Example may be incomplete for required fields; still exercise setDefaults path.
		_ = err
	}
	if C.Server.Port == 0 {
		t.Fatal("expected default or loaded port")
	}
}

func TestReadyHelpers(t *testing.T) {
	if (CloudflareConfig{}).Ready() {
		t.Fatal("empty cloudflare should not be ready")
	}
	if !(CloudflareConfig{AccountID: "a", APIToken: "t", ZoneID: "z"}).Ready() {
		t.Fatal("expected cloudflare ready")
	}
	if (StripeConfig{SecretKey: "sk"}).Ready() {
		t.Fatal("stripe disabled should not be ready")
	}
	if !(StripeConfig{Enabled: true, SecretKey: "sk"}).Ready() {
		t.Fatal("expected stripe ready")
	}
}

func TestDevModeAndCookieSecure(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "")
	if DevMode() {
		t.Fatal("expected DevMode false")
	}
	t.Setenv("LUNACONNECT_DEV", "1")
	if !DevMode() {
		t.Fatal("expected DevMode true")
	}
	orig := C.Server.BaseURL
	t.Cleanup(func() { C.Server.BaseURL = orig })
	C.Server.BaseURL = "https://example.com"
	if !CookieSecure() {
		t.Fatal("https should be secure")
	}
	C.Server.BaseURL = "http://localhost"
	if CookieSecure() {
		t.Fatal("http should not be secure")
	}
}
