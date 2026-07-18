package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

func setupConnectTest(t *testing.T) (*ConnectHandler, *settings.Service, *network.CaddyManager, *storage.BackupService, *database.DB) {
	t.Helper()
	tmpDir := t.TempDir()

	cfg := &config.Config{
		Server: config.ServerConfig{Host: "127.0.0.1", Port: 8080, Mode: "development"},
		Network: config.NetworkConfig{
			Caddy: config.CaddyConfig{
				Mode:          "noop",
				ConfigPath:    filepath.Join(tmpDir, "caddy", "Caddyfile"),
				DefaultDomain: "old.example.com",
				AutoHTTPS:     false,
			},
		},
		SMTP: config.SMTPConfig{},
		Connect: config.ConnectConfig{
			ServiceStates: map[string]string{},
		},
	}
	config.SetTestConfig(cfg)
	t.Cleanup(func() { config.SetTestConfig(nil) })

	db, err := database.Open(filepath.Join(tmpDir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open test database: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("failed to migrate test database: %v", err)
	}
	sqlDB := db.SQL()

	svc := settings.NewService(sqlDB)

	networkCfg := network.CaddyConfig{
		Mode:          cfg.Network.Caddy.Mode,
		ConfigPath:    cfg.Network.Caddy.ConfigPath,
		DefaultDomain: cfg.Network.Caddy.DefaultDomain,
		AutoHTTPS:     cfg.Network.Caddy.AutoHTTPS,
	}
	cm := network.NewCaddyManager(db, networkCfg)

	// Give the backup service a fake restic binary so ProvisionRestic succeeds
	// without downloading anything from the network.
	homeDir := filepath.Join(tmpDir, "home")
	resticBin := filepath.Join(homeDir, ".libreserv", "bin", "restic")
	if err := os.MkdirAll(filepath.Dir(resticBin), 0o750); err != nil {
		t.Fatalf("failed to create fake restic dir: %v", err)
	}
	if err := os.WriteFile(resticBin, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatalf("failed to write fake restic binary: %v", err)
	}
	t.Setenv("HOME", homeDir)

	backupSvc := storage.NewBackupService(db, nil, filepath.Join(tmpDir, "backups"), filepath.Join(tmpDir, "appdata"))
	backupSvc.SetEncryptionKey("test-encryption-key-for-testing-only")

	return NewConnectHandler(connect.NewFakeClient(), nil, svc, cm, backupSvc, nil), svc, cm, backupSvc, db
}

func TestConnectUpdateServicesAppliesSMTP(t *testing.T) {
	handler, svc, _, _, _ := setupConnectTest(t)

	// Avoid dialing a real SMTP server in tests.
	oldValidator := smtpValidator
	smtpValidator = func(_ config.SMTPConfig) error { return nil }
	t.Cleanup(func() { smtpValidator = oldValidator })

	_, _ = handler.client.Activate(context.Background(), "test-lite-token-12345")

	body, _ := json.Marshal(map[string]string{"service": "smtp", "state": "connected"})
	req := httptest.NewRequest(http.MethodPut, "/connect/services", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.UpdateServices(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	settings, err := svc.GetSettings(context.Background())
	if err != nil {
		t.Fatalf("failed to get settings: %v", err)
	}
	smtp, ok := settings["smtp"].(map[string]interface{})
	if !ok {
		t.Fatal("smtp settings not found")
	}
	if smtp["host"] != "smtp.libreloom.org" {
		t.Errorf("expected smtp host smtp.libreloom.org, got %v", smtp["host"])
	}
	if smtp["port"] != 587 {
		t.Errorf("expected smtp port 587, got %v", smtp["port"])
	}
	if smtp["username"] != "server-test-lit" {
		t.Errorf("expected username from token, got %v", smtp["username"])
	}
	if smtp["use_tls"] != true {
		t.Errorf("expected use_tls true, got %v", smtp["use_tls"])
	}
}

func TestConnectUpdateServicesAppliesDomain(t *testing.T) {
	handler, svc, cm, _, _ := setupConnectTest(t)

	_, _ = handler.client.Activate(context.Background(), "test-lite-token-12345")

	body, _ := json.Marshal(map[string]string{"service": "domain", "state": "connected"})
	req := httptest.NewRequest(http.MethodPut, "/connect/services", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.UpdateServices(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	settings, err := svc.GetSettings(context.Background())
	if err != nil {
		t.Fatalf("failed to get settings: %v", err)
	}
	proxy, ok := settings["proxy"].(map[string]interface{})
	if !ok {
		t.Fatal("proxy settings not found")
	}
	if proxy["default_domain"] != "test-lit.servers.libreloom.org" {
		t.Errorf("expected default_domain from token, got %v", proxy["default_domain"])
	}
	if proxy["auto_https"] != true {
		t.Errorf("expected auto_https true, got %v", proxy["auto_https"])
	}

	if cm.Config().DefaultDomain != "test-lit.servers.libreloom.org" {
		t.Errorf("expected caddy default domain updated, got %v", cm.Config().DefaultDomain)
	}
	if cm.Config().AutoHTTPS != true {
		t.Errorf("expected caddy auto_https updated, got %v", cm.Config().AutoHTTPS)
	}
}

func TestConnectUpdateServicesAppliesBackup(t *testing.T) {
	handler, _, _, backupSvc, db := setupConnectTest(t)

	_, _ = handler.client.Activate(context.Background(), "test-lite-token-12345")

	body, _ := json.Marshal(map[string]string{"service": "backup", "state": "connected"})
	req := httptest.NewRequest(http.MethodPut, "/connect/services", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.UpdateServices(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var count int
	err := db.SQL().QueryRow(`SELECT COUNT(*) FROM backup_repositories WHERE is_system = 0`).Scan(&count)
	if err != nil {
		t.Fatalf("failed to count backup repositories: %v", err)
	}
	if count != 1 {
		t.Errorf("expected one non-system backup repository, got %d", count)
	}

	var repoType, repoPath, credentials string
	err = db.SQL().QueryRow(`
		SELECT repo_type, repo_path, credentials
		FROM backup_repositories
		WHERE is_system = 0
	`).Scan(&repoType, &repoPath, &credentials)
	if err != nil {
		t.Fatalf("failed to query backup repository: %v", err)
	}
	if repoType != "s3" {
		t.Errorf("expected repo type s3, got %v", repoType)
	}
	if repoPath != "s3:https://s3.libreloom.org/libreserv-backup/test-lit" {
		t.Errorf("expected repo path from token, got %v", repoPath)
	}
	if credentials == "" {
		t.Error("expected encrypted credentials to be stored")
	}

	if !backupSvc.UseRestic() {
		t.Error("expected backup service to have restic available after provisioning")
	}
}

func TestConnectUpdateServicesDoesNotPersistOnApplyFailure(t *testing.T) {
	handler, svc, _, _, _ := setupConnectTest(t)

	oldValidator := smtpValidator
	smtpValidator = func(_ config.SMTPConfig) error { return fmt.Errorf("simulated smtp failure") }
	t.Cleanup(func() { smtpValidator = oldValidator })

	_, _ = handler.client.Activate(context.Background(), "test-lite-token-12345")

	body, _ := json.Marshal(map[string]string{"service": "smtp", "state": "connected"})
	req := httptest.NewRequest(http.MethodPut, "/connect/services", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.UpdateServices(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected status 502, got %d: %s", rec.Code, rec.Body.String())
	}

	settings, err := svc.GetSettings(context.Background())
	if err != nil {
		t.Fatalf("failed to get settings: %v", err)
	}
	smtp, ok := settings["smtp"].(map[string]interface{})
	if !ok {
		t.Fatal("smtp settings not found")
	}
	if smtp["host"] != "" {
		t.Errorf("expected smtp host to remain empty after failed apply, got %v", smtp["host"])
	}
}
