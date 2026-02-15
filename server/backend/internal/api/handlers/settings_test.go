package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func TestSettingsGet(t *testing.T) {
	// Initialize config with test values
	cfg := &config.Config{
		Server: config.ServerConfig{
			Host: "localhost",
			Port: 8080,
			Mode: "development",
		},
		Logging: config.LoggingConfig{
			Level: "debug",
			Path:  "/var/log",
		},
		Network: config.NetworkConfig{
			Caddy: config.CaddyConfig{
				Mode:          "enabled",
				AdminAPI:      "localhost:2019",
				ConfigPath:    "/etc/caddy/Caddyfile",
				DefaultDomain: "example.com",
				AutoHTTPS:     true,
			},
		},
	}
	config.SetTestConfig(cfg)

	handler := NewSettingsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/settings", nil)
	rec := httptest.NewRecorder()

	handler.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var response map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	// Check backend settings
	backend, ok := response["backend"].(map[string]interface{})
	if !ok {
		t.Fatal("backend settings not found")
	}
	if backend["host"] != "localhost" {
		t.Errorf("expected host localhost, got %v", backend["host"])
	}
	if backend["port"].(float64) != 8080 {
		t.Errorf("expected port 8080, got %v", backend["port"])
	}
	if backend["mode"] != "development" {
		t.Errorf("expected mode development, got %v", backend["mode"])
	}

	// Check proxy settings
	proxy, ok := response["proxy"].(map[string]interface{})
	if !ok {
		t.Fatal("proxy settings not found")
	}
	if proxy["type"] != "caddy" {
		t.Errorf("expected proxy type caddy, got %v", proxy["type"])
	}
	if proxy["mode"] != "enabled" {
		t.Errorf("expected proxy mode enabled, got %v", proxy["mode"])
	}
	if proxy["admin_api"] != "localhost:2019" {
		t.Errorf("expected admin_api localhost:2019, got %v", proxy["admin_api"])
	}
	if proxy["default_domain"] != "example.com" {
		t.Errorf("expected default_domain example.com, got %v", proxy["default_domain"])
	}
	if proxy["auto_https"] != true {
		t.Errorf("expected auto_https true, got %v", proxy["auto_https"])
	}

	// Check logging settings
	logging, ok := response["logging"].(map[string]interface{})
	if !ok {
		t.Fatal("logging settings not found")
	}
	if logging["level"] != "debug" {
		t.Errorf("expected level debug, got %v", logging["level"])
	}

	t.Log("Settings response:", rec.Body.String())
}

func TestSettingsGetNoProxy(t *testing.T) {
	// Initialize config without proxy settings
	cfg := &config.Config{
		Server: config.ServerConfig{
			Host: "0.0.0.0",
			Port: 3000,
			Mode: "production",
		},
		Logging: config.LoggingConfig{
			Level: "info",
			Path:  "",
		},
		Network: config.NetworkConfig{
			Caddy: config.CaddyConfig{
				// Empty caddy config - no proxy
			},
		},
	}
	config.SetTestConfig(cfg)

	handler := NewSettingsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/settings", nil)
	rec := httptest.NewRecorder()

	handler.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var response map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	// Backend should still exist
	backend, ok := response["backend"].(map[string]interface{})
	if !ok {
		t.Fatal("backend settings not found")
	}
	if backend["port"].(float64) != 3000 {
		t.Errorf("expected port 3000, got %v", backend["port"])
	}

	// Proxy should not exist when not configured
	if _, exists := response["proxy"]; exists {
		t.Error("proxy settings should not exist when caddy is not configured")
	}

	t.Log("Settings response:", rec.Body.String())
}
