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
	"strings"
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

// TestConnectReconcileDomainCredential covers the stale-default_domain bug:
// Connect's domain coordinator pre-provisions the domain credential server-side
// during activation, so the device's auto-provision loop (disabled-only) skips
// it — leaving a stale local Caddy default_domain. reconcileDomainCredential
// must re-apply the Connect-served domain when it differs from the local one.
func TestConnectReconcileDomainCredential(t *testing.T) {
	handler, svc, cm, _, _ := setupConnectTest(t)

	// Local default domain starts at the stale value (old.example.com from
	// setupConnectTest) — simulate the activation having been skipped.
	_, _ = handler.client.Activate(context.Background(), "test-lite-token-12345")

	// The Connect status reports the domain service connected with the
	// device's assigned subdomain — different from the local stale one.
	status := &connect.ConnectStatus{
		Connected: true,
		Plan:      &connect.ConnectPlan{ID: connect.PlanLite, Name: "Connect Lite"},
		Services: map[connect.ServiceID]connect.ServiceStatus{
			connect.ServiceDomain: {
				State:   connect.ServiceConnected,
				Label:   "Domain & DNS",
				Details: map[string]string{"type": "subdomain", "domain": "test-lit.servers.libreloom.org"},
			},
		},
	}

	handler.reconcileDomainCredential(context.Background(), status)

	settings, err := svc.GetSettings(context.Background())
	if err != nil {
		t.Fatalf("failed to get settings: %v", err)
	}
	proxy, ok := settings["proxy"].(map[string]interface{})
	if !ok {
		t.Fatal("proxy settings not found")
	}
	if proxy["default_domain"] != "test-lit.servers.libreloom.org" {
		t.Errorf("expected default_domain reconciled to test-lit.servers.libreloom.org, got %v", proxy["default_domain"])
	}
	if cm.Config().DefaultDomain != "test-lit.servers.libreloom.org" {
		t.Errorf("expected caddy default domain reconciled, got %v", cm.Config().DefaultDomain)
	}
}

// TestConnectReconcileDomainCredentialNoopWhenMatching ensures the reconcile
// is a no-op when the local domain already matches Connect — so it's safe to
// run on every status poll.
func TestConnectReconcileDomainCredentialNoopWhenMatching(t *testing.T) {
	handler, svc, _, _, _ := setupConnectTest(t)

	_, _ = handler.client.Activate(context.Background(), "test-lite-token-12345")

	// Apply the correct domain first.
	status := &connect.ConnectStatus{
		Connected: true,
		Plan:      &connect.ConnectPlan{ID: connect.PlanLite, Name: "Connect Lite"},
		Services: map[connect.ServiceID]connect.ServiceStatus{
			connect.ServiceDomain: {
				State:   connect.ServiceConnected,
				Label:   "Domain & DNS",
				Details: map[string]string{"type": "subdomain", "domain": "test-lit.servers.libreloom.org"},
			},
		},
	}
	handler.reconcileDomainCredential(context.Background(), status)

	// Second pass with an identical status must not change anything.
	handler.reconcileDomainCredential(context.Background(), status)

	settings, err := svc.GetSettings(context.Background())
	if err != nil {
		t.Fatalf("failed to get settings: %v", err)
	}
	proxy, ok := settings["proxy"].(map[string]interface{})
	if !ok {
		t.Fatal("proxy settings not found")
	}
	if proxy["default_domain"] != "test-lit.servers.libreloom.org" {
		t.Errorf("expected default_domain to remain test-lit.servers.libreloom.org, got %v", proxy["default_domain"])
	}
}

// failingConnectClient returns a canned error from Activate; the remaining
// interface methods are no-op stubs so the handler can be constructed with it.
type failingConnectClient struct{ err error }

func (f failingConnectClient) Activate(context.Context, string) (*connect.ConnectStatus, error) {
	return nil, f.err
}
func (f failingConnectClient) Deactivate(context.Context) error { return nil }
func (f failingConnectClient) Provision(context.Context, connect.ServiceID) (*connect.ProvisionedCredentials, error) {
	return nil, nil
}
func (f failingConnectClient) RegisterRoute(context.Context, string) error   { return nil }
func (f failingConnectClient) UnregisterRoute(context.Context, string) error { return nil }
func (f failingConnectClient) DeleteTunnel(context.Context) error            { return nil }
func (f failingConnectClient) Status(context.Context) (*connect.ConnectStatus, error) {
	return nil, nil
}
func (f failingConnectClient) Usage(context.Context) (*connect.UsageSummary, error) { return nil, nil }
func (f failingConnectClient) Info(context.Context) (*connect.ConnectInfo, error)   { return nil, nil }
func (f failingConnectClient) VerifyProbe(context.Context, string, int, string) (*connect.VerifyProbeResult, error) {
	return nil, nil
}
func (f failingConnectClient) ConnectKey() string { return "" }

// TestConnectActivateErrorMessages covers the plain-language, actionable
// activation errors: each failure mode must say what happened and what to do
// (invalid key, revoked key, already-active key, cloud unreachable) instead of
// one generic "could not connect" message.
func TestConnectActivateErrorMessages(t *testing.T) {
	tests := []struct {
		name         string
		err          error
		wantStatus   int
		wantFragment string
	}{
		{"invalid key", &connect.ConnectAPIError{StatusCode: http.StatusUnauthorized, Message: "invalid Connect key"}, http.StatusBadRequest, "didn't work"},
		{"revoked key", &connect.ConnectAPIError{StatusCode: http.StatusForbidden, Message: "this Connect key has been revoked"}, http.StatusBadRequest, "turned off"},
		{"key already active elsewhere", &connect.ConnectAPIError{StatusCode: http.StatusConflict, Message: "This account already has an activated device. Deactivate it first to activate a new one."}, http.StatusConflict, "already in use"},
		{"cloud unreachable", fmt.Errorf("connect request failed: EOF"), http.StatusBadGateway, "couldn't reach"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &ConnectHandler{client: failingConnectClient{err: tt.err}}
			body, _ := json.Marshal(map[string]string{"connect_key": "XXXX-YYYY-ZZZZ"})
			req := httptest.NewRequest(http.MethodPut, "/connect/activate", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			h.Activate(rec, req)
			if rec.Code != tt.wantStatus {
				t.Fatalf("expected status %d, got %d: %s", tt.wantStatus, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tt.wantFragment) {
				t.Fatalf("expected body to contain %q, got: %s", tt.wantFragment, rec.Body.String())
			}
		})
	}
}
