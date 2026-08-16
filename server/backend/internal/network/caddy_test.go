package network

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func setupTestDB(t *testing.T) *database.DB {
	t.Helper()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("Failed to create test database: %v", err)
	}
	if err := db.Migrate(); err != nil {
		db.Close()
		t.Fatalf("Failed to migrate database: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
	})
	return db
}

func setupTestCaddyManager(t *testing.T, mode string) (*CaddyManager, string) {
	t.Helper()
	db := setupTestDB(t)
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "Caddyfile")

	config := CaddyConfig{
		Mode:          mode,
		AdminAPI:      "",
		ConfigPath:    configPath,
		DefaultDomain: "test.local",
		Email:         "test@example.com",
		AutoHTTPS:     false,
		Reload: CaddyReloadConfig{
			Retries:        3,
			BackoffMin:     100 * time.Millisecond,
			BackoffMax:     1 * time.Second,
			JitterFraction: 0.1,
			AttemptTimeout: 2 * time.Second,
		},
		Logging: CaddyLoggingConfig{
			Output: "stdout",
			Format: "console",
			Level:  "INFO",
		},
	}

	cm := NewCaddyManager(db, config)
	return cm, tmpDir
}

func TestCaddyManager_Mode(t *testing.T) {
	tests := []struct {
		name     string
		mode     string
		wantMode string
		enabled  bool
	}{
		{"enabled", "enabled", "enabled", true},
		{"noop", "noop", "noop", false},
		{"disabled", "disabled", "disabled", false},
		{"empty defaults to disabled", "", "disabled", false},
		{"uppercase normalized", "ENABLED", "enabled", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cm, _ := setupTestCaddyManager(t, tt.mode)

			if got := cm.mode(); got != tt.wantMode {
				t.Errorf("mode() = %v, want %v", got, tt.wantMode)
			}
			if got := cm.isEnabled(); got != tt.enabled {
				t.Errorf("isEnabled() = %v, want %v", got, tt.enabled)
			}
		})
	}
}

func TestCaddyManager_SetMode(t *testing.T) {
	tests := []struct {
		name    string
		from    string
		to      string
		wantErr bool
	}{
		{"disabled to enabled", "disabled", "enabled", false},
		{"enabled to disabled", "enabled", "disabled", false},
		{"noop to disabled", "noop", "disabled", false},
		{"invalid mode", "disabled", "invalid", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cm, _ := setupTestCaddyManager(t, tt.from)
			if tt.from == "enabled" {
				if err := cm.Initialize(context.Background()); err != nil {
					t.Fatalf("Initialize() failed: %v", err)
				}
			}

			err := cm.SetMode(tt.to)
			if tt.wantErr {
				if err == nil {
					t.Error("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("SetMode() failed: %v", err)
			}
			if got := cm.mode(); got != tt.to {
				t.Errorf("mode() = %v, want %v", got, tt.to)
			}
		})
	}
}

func TestCaddyManager_Initialize(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "enabled")

	ctx := context.Background()
	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Check that Caddyfile was created
	if _, err := os.Stat(cm.config.ConfigPath); os.IsNotExist(err) {
		t.Error("Caddyfile was not created")
	}
}

func TestCaddyManager_AddRoute(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Add a route
	route, err := cm.AddRoute(ctx, "app1", "", "http://localhost:8080", "test-app-1")
	if err != nil {
		t.Fatalf("AddRoute() failed: %v", err)
	}

	if route.Subdomain != "app1" {
		t.Errorf("Expected subdomain 'app1', got %s", route.Subdomain)
	}
	if route.Backend != "http://localhost:8080" {
		t.Errorf("Expected backend 'http://localhost:8080', got %s", route.Backend)
	}
	if route.Domain != "test.local" {
		t.Errorf("Expected domain 'test.local', got %s", route.Domain)
	}

	// Try to add duplicate route
	_, err = cm.AddRoute(ctx, "app1", "", "http://localhost:8081", "test-app-2")
	if err == nil {
		t.Error("Expected error when adding duplicate route, got nil")
	}
}

func TestCaddyManager_RemoveRoute(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Add a route
	route, err := cm.AddRoute(ctx, "app1", "", "http://localhost:8080", "test-app-1")
	if err != nil {
		t.Fatalf("AddRoute() failed: %v", err)
	}

	// Remove the route
	if err := cm.RemoveRoute(ctx, route.ID); err != nil {
		t.Fatalf("RemoveRoute() failed: %v", err)
	}

	// Verify route is gone
	_, err = cm.GetRoute(route.ID)
	if err == nil {
		t.Error("Expected error when getting removed route, got nil")
	}
}

func TestCaddyManager_UpdateRoute(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Add a route
	route, err := cm.AddRoute(ctx, "app1", "", "http://localhost:8080", "test-app-1")
	if err != nil {
		t.Fatalf("AddRoute() failed: %v", err)
	}

	// Update the route
	updatedRoute, err := cm.UpdateRoute(ctx, route.ID, "http://localhost:9090", false)
	if err != nil {
		t.Fatalf("UpdateRoute() failed: %v", err)
	}

	if updatedRoute.Backend != "http://localhost:9090" {
		t.Errorf("Expected backend 'http://localhost:9090', got %s", updatedRoute.Backend)
	}
	if updatedRoute.Enabled != false {
		t.Error("Expected route to be disabled")
	}
}

func TestCaddyManager_IsDomainAvailable(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Check available domain
	if !cm.IsDomainAvailable("app1", "") {
		t.Error("Expected domain to be available")
	}

	// Add a route
	_, err := cm.AddRoute(ctx, "app1", "", "http://localhost:8080", "test-app-1")
	if err != nil {
		t.Fatalf("AddRoute() failed: %v", err)
	}

	// Check unavailable domain
	if cm.IsDomainAvailable("app1", "") {
		t.Error("Expected domain to be unavailable")
	}
}

func TestCaddyManager_GenerateCaddyfile(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Add some routes
	_, err := cm.AddRoute(ctx, "app1", "", "http://localhost:8080", "test-app-1")
	if err != nil {
		t.Fatalf("AddRoute() failed: %v", err)
	}

	_, err = cm.AddRoute(ctx, "app2", "", "http://localhost:8081", "test-app-2")
	if err != nil {
		t.Fatalf("AddRoute() failed: %v", err)
	}

	// Generate Caddyfile
	content, err := cm.generateCaddyfileLocked()
	if err != nil {
		t.Fatalf("generateCaddyfileLocked() failed: %v", err)
	}

	// Check content contains expected elements
	if content == "" {
		t.Error("Generated Caddyfile is empty")
	}

	// Should contain email
	if cm.config.Email != "" && !contains(content, cm.config.Email) {
		t.Error("Caddyfile should contain email")
	}

	// Should contain route domains
	if !contains(content, "app1.test.local") {
		t.Error("Caddyfile should contain app1.test.local")
	}
	if !contains(content, "app2.test.local") {
		t.Error("Caddyfile should contain app2.test.local")
	}

	// Should contain backends
	if !contains(content, "localhost:8080") {
		t.Error("Caddyfile should contain localhost:8080")
	}
	if !contains(content, "localhost:8081") {
		t.Error("Caddyfile should contain localhost:8081")
	}
}

func TestCaddyManager_GetStatus(t *testing.T) {
	tests := []struct {
		name         string
		mode         string
		wantRunning  bool
		wantErrorMsg bool
	}{
		{"enabled mode", "enabled", false, false},
		{"noop mode", "noop", false, true},
		{"disabled mode", "disabled", false, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cm, _ := setupTestCaddyManager(t, tt.mode)
			ctx := context.Background()

			if err := cm.Initialize(ctx); err != nil {
				t.Fatalf("Initialize() failed: %v", err)
			}

			status, err := cm.GetStatus(ctx)
			if err != nil {
				t.Fatalf("GetStatus() failed: %v", err)
			}

			if status.Mode != tt.mode {
				t.Errorf("Expected mode %s, got %s", tt.mode, status.Mode)
			}

			if tt.wantErrorMsg && status.Error == "" {
				t.Error("Expected error message in status")
			}
		})
	}
}

func TestCaddyManager_UpdateDefaults(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Update defaults
	err := cm.UpdateDefaults("new.domain.com", "new@example.com", true)
	if err != nil {
		t.Fatalf("UpdateDefaults() failed: %v", err)
	}

	// Verify updates
	if cm.config.DefaultDomain != "new.domain.com" {
		t.Errorf("Expected default domain 'new.domain.com', got %s", cm.config.DefaultDomain)
	}
	if cm.config.Email != "new@example.com" {
		t.Errorf("Expected email 'new@example.com', got %s", cm.config.Email)
	}
	if !cm.config.AutoHTTPS {
		t.Error("Expected AutoHTTPS to be true")
	}
}

// TestCaddyManager_UpdateDefaultsMigratesRoutes covers the stale-route bug:
// when the default domain changes (e.g. a Connect subdomain move), every route
// that was created under the old default domain must be rewritten to the new
// one — in memory AND in the database — while custom-domain routes stay put.
func TestCaddyManager_UpdateDefaultsMigratesRoutes(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Two app routes under the OLD default domain (test.local from setup).
	_, err := cm.AddRoute(ctx, "convertx", "test.local", "http://localhost:3002", "app-1")
	if err != nil {
		t.Fatalf("AddRoute(convertx) failed: %v", err)
	}
	_, err = cm.AddRoute(ctx, "nextcloud", "test.local", "http://localhost:3003", "app-2")
	if err != nil {
		t.Fatalf("AddRoute(nextcloud) failed: %v", err)
	}
	// One custom-domain route that must NOT migrate.
	_, err = cm.AddDomainRoute(ctx, "myapp.custom.com", "http://localhost:3004", "custom")
	if err != nil {
		t.Fatalf("AddDomainRoute failed: %v", err)
	}

	var migrated string
	cm.SetOnDefaultDomainChanged(func(oldD, newD string) { migrated = oldD + "->" + newD })

	if err := cm.UpdateDefaults("new.local", "", false); err != nil {
		t.Fatalf("UpdateDefaults() failed: %v", err)
	}

	// In-memory routes migrated.
	if r, ok := cm.FindRouteByDomain("convertx.new.local"); !ok {
		t.Errorf("expected convertx.new.local to exist after migration")
	} else if r.Backend != "http://localhost:3002" {
		t.Errorf("expected backend preserved, got %s", r.Backend)
	}
	if _, ok := cm.FindRouteByDomain("nextcloud.new.local"); !ok {
		t.Error("expected nextcloud.new.local to exist after migration")
	}
	// Old domains gone.
	if _, ok := cm.FindRouteByDomain("convertx.test.local"); ok {
		t.Error("expected convertx.test.local to be gone after migration")
	}
	// Custom domain untouched.
	if r, ok := cm.FindRouteByDomain("myapp.custom.com"); !ok || r.Backend != "http://localhost:3004" {
		t.Error("expected custom-domain route to be untouched")
	}
	// Hook fired with the right old/new pair.
	if migrated != "test.local->new.local" {
		t.Errorf("expected hook test.local->new.local, got %q", migrated)
	}

	// Database persisted: reload a fresh manager over the SAME database and
	// confirm the migrated routes survive.
	db2 := cm.db
	cm2 := NewCaddyManager(db2, CaddyConfig{
		Mode:          "noop",
		ConfigPath:    filepath.Join(t.TempDir(), "Caddyfile2"),
		DefaultDomain: "new.local",
		AutoHTTPS:     false,
	})
	if err := cm2.Initialize(ctx); err != nil {
		t.Fatalf("reload Initialize() failed: %v", err)
	}
	if _, ok := cm2.FindRouteByDomain("convertx.new.local"); !ok {
		t.Error("expected migrated route to persist in the database")
	}
	if _, ok := cm2.FindRouteByDomain("myapp.custom.com"); !ok {
		t.Error("expected custom-domain route to persist in the database")
	}
}

// TestCaddyManager_UpdateDefaultsSameDomainNoMigration ensures no migration
// runs when the domain doesn't actually change.
func TestCaddyManager_UpdateDefaultsSameDomainNoMigration(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}
	if _, err := cm.AddRoute(ctx, "convertx", "test.local", "http://localhost:3002", "app-1"); err != nil {
		t.Fatalf("AddRoute failed: %v", err)
	}

	var fired bool
	cm.SetOnDefaultDomainChanged(func(_, _ string) { fired = true })

	if err := cm.UpdateDefaults("test.local", "", false); err != nil {
		t.Fatalf("UpdateDefaults() failed: %v", err)
	}
	if fired {
		t.Error("expected no domain-changed hook when domain is unchanged")
	}
	if _, ok := cm.FindRouteByDomain("convertx.test.local"); !ok {
		t.Error("expected route to remain on the original domain")
	}
}

func TestCaddyManager_ReloadInDisabledMode(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "disabled")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Reload should return error in disabled mode
	err := cm.reloadCaddy()
	if err == nil {
		t.Error("Expected error when reloading in disabled mode")
	}

	// Check it's the right error type
	var caddyErr *CaddyError
	if !errors.As(err, &caddyErr) {
		t.Error("Expected CaddyError type")
	}
}

func TestCaddyManager_AddDomainRoute(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Add a domain route
	route, err := cm.AddDomainRoute(ctx, "example.com", "http://localhost:8080", "acme-auto")
	if err != nil {
		t.Fatalf("AddDomainRoute() failed: %v", err)
	}

	if route.Domain != "example.com" {
		t.Errorf("Expected domain 'example.com', got %s", route.Domain)
	}
	if route.Subdomain != "" {
		t.Errorf("Expected empty subdomain, got %s", route.Subdomain)
	}
	if route.Comment != "acme-auto" {
		t.Errorf("Expected comment 'acme-auto', got %s", route.Comment)
	}
}

func TestCaddyManager_GetRouteByApp(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Add a route
	appID := "test-app-123"
	_, err := cm.AddRoute(ctx, "app1", "", "http://localhost:8080", appID)
	if err != nil {
		t.Fatalf("AddRoute() failed: %v", err)
	}

	// Get route by app
	route, err := cm.GetRouteByApp(appID)
	if err != nil {
		t.Fatalf("GetRouteByApp() failed: %v", err)
	}

	if route.AppID != appID {
		t.Errorf("Expected app ID %s, got %s", appID, route.AppID)
	}
}

func TestCaddyManager_FindRouteByDomain(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("Initialize() failed: %v", err)
	}

	// Add a route
	_, err := cm.AddRoute(ctx, "app1", "", "http://localhost:8080", "test-app-1")
	if err != nil {
		t.Fatalf("AddRoute() failed: %v", err)
	}

	// Find by domain
	route, found := cm.FindRouteByDomain("app1.test.local")
	if !found {
		t.Fatal("Route not found")
	}

	if route.FullDomain() != "app1.test.local" {
		t.Errorf("Expected domain 'app1.test.local', got %s", route.FullDomain())
	}

	// Try non-existent domain
	_, found = cm.FindRouteByDomain("nonexistent.test.local")
	if found {
		t.Error("Should not find non-existent domain")
	}
}

func contains(s, substr string) bool {
	return len(s) > 0 && len(substr) > 0 && (s == substr || len(s) > len(substr) && contains(s[1:], substr) || s[0:len(substr)] == substr)
}

func TestCaddyManager_certDirForDomain_Wildcard(t *testing.T) {
	cm, tmpDir := setupTestCaddyManager(t, "noop")
	cm.config.CertsPath = filepath.Join(tmpDir, "certs")

	dir := cm.certDirForDomain("*.example.com")
	if dir == "" {
		t.Fatal("certDirForDomain returned empty for wildcard")
	}
	wantDir := filepath.Join(cm.config.CertsPath, "wildcard.example.com")
	if dir != wantDir {
		t.Fatalf("wildcard cert dir = %q, want %q", dir, wantDir)
	}

	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatalf("create wildcard cert dir: %v", err)
	}
	certFile := filepath.Join(dir, "fullchain.pem")
	keyFile := filepath.Join(dir, "privkey.pem")
	if err := os.WriteFile(certFile, []byte("cert"), 0o644); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(keyFile, []byte("key"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	gotCert, gotKey, ok := cm.certPathsForDomain("*.example.com")
	if !ok {
		t.Fatal("certPathsForDomain did not find wildcard cert")
	}
	if gotCert != certFile || gotKey != keyFile {
		t.Fatalf("certPathsForDomain returned %q %q, want %q %q", gotCert, gotKey, certFile, keyFile)
	}
}
