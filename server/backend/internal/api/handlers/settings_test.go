package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
)

func TestSettingsGet(t *testing.T) {
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

	handler := NewSettingsHandler(nil, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/settings", nil)
	rec := httptest.NewRecorder()

	handler.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var response map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	server, ok := response["server"].(map[string]interface{})
	if !ok {
		t.Fatal("server settings not found")
	}
	if server["host"] != "localhost" {
		t.Errorf("expected host localhost, got %v", server["host"])
	}
	if server["port"].(float64) != 8080 {
		t.Errorf("expected port 8080, got %v", server["port"])
	}

	proxy, ok := response["proxy"].(map[string]interface{})
	if !ok {
		t.Fatal("proxy settings not found")
	}
	if proxy["type"] != "caddy" {
		t.Errorf("expected proxy type caddy, got %v", proxy["type"])
	}
	if proxy["default_domain"] != "example.com" {
		t.Errorf("expected default_domain example.com, got %v", proxy["default_domain"])
	}

	logging, ok := response["logging"].(map[string]interface{})
	if !ok {
		t.Fatal("logging settings not found")
	}
	if logging["level"] != "debug" {
		t.Errorf("expected level debug, got %v", logging["level"])
	}
}

func TestSettingsGetNoProxy(t *testing.T) {
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
			Caddy: config.CaddyConfig{},
		},
	}
	config.SetTestConfig(cfg)

	handler := NewSettingsHandler(nil, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/settings", nil)
	rec := httptest.NewRecorder()

	handler.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var response map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	server, ok := response["server"].(map[string]interface{})
	if !ok {
		t.Fatal("server settings not found")
	}
	if server["port"].(float64) != 3000 {
		t.Errorf("expected port 3000, got %v", server["port"])
	}

	if _, exists := response["proxy"]; exists {
		t.Error("proxy settings should not exist when caddy is not configured")
	}
}

func TestSettingsUpdateLogLevelWithDB(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "test-config.yaml")

	yamlContent := "server:\n  host: localhost\n  port: 8080\nlogging:\n  level: info\n"
	if err := os.WriteFile(cfgPath, []byte(yamlContent), 0o600); err != nil {
		t.Fatalf("failed to write test config: %v", err)
	}

	if err := config.LoadConfig(cfgPath); err != nil {
		t.Fatalf("failed to load test config: %v", err)
	}

	handler := NewSettingsHandler(nil, nil, nil)
	body := `{"logging":{"level":"debug"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.Update(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 (no settings service), got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSettingsUpdateInvalidLevel(t *testing.T) {
	cfg := &config.Config{
		Logging: config.LoggingConfig{Level: "info"},
	}
	config.SetTestConfig(cfg)

	handler := NewSettingsHandler(nil, nil, nil)
	body := `{"logging":{"level":"verbose"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.Update(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 (no settings service), got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSettingsUpdateInvalidBody(t *testing.T) {
	cfg := &config.Config{
		Logging: config.LoggingConfig{Level: "info"},
	}
	config.SetTestConfig(cfg)

	handler := NewSettingsHandler(nil, nil, nil)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.Update(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", rec.Code)
	}
}

func TestSettingsUpdateProxy(t *testing.T) {
	cfg := &config.Config{
		Network: config.NetworkConfig{
			Caddy: config.CaddyConfig{
				Mode:          "enabled",
				AdminAPI:      "localhost:2019",
				DefaultDomain: "old.example.com",
				Email:         "old@example.com",
				AutoHTTPS:     false,
			},
		},
		Auth: config.AuthConfig{
			CSRFSecret: "test-secret-for-testing-purposes-only",
		},
	}
	config.SetTestConfig(cfg)

	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("failed to open test database: %v", err)
	}
	defer db.Close()

	// Migrate database to create tables
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		t.Fatalf("failed to enable foreign keys: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS app_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		type TEXT NOT NULL DEFAULT 'string',
		updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		t.Fatalf("failed to create app_settings table: %v", err)
	}

	svc := settings.NewService(db)
	handler := NewSettingsHandler(svc, nil, nil)
	body := `{"default_domain":"new.example.com","ssl_email":"admin@example.com","auto_https":true}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings/proxy", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.UpdateProxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var response map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	proxy, ok := response["proxy"].(map[string]interface{})
	if !ok {
		t.Fatal("proxy not found in response")
	}

	if proxy["default_domain"] != "new.example.com" {
		t.Errorf("expected default_domain new.example.com, got %v", proxy["default_domain"])
	}

	if proxy["ssl_email"] != "admin@example.com" {
		t.Logf("DEBUG: ssl_email value is %v (type: %T)", proxy["ssl_email"], proxy["ssl_email"])
		t.Logf("DEBUG: Full proxy map: %+v", proxy)
		t.Errorf("expected ssl_email admin@example.com, got %v", proxy["ssl_email"])
	}

	if proxy["auto_https"] != true {
		t.Errorf("expected auto_https true, got %v", proxy["auto_https"])
	}
}
