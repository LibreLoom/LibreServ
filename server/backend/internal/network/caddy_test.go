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
		disabled bool
	}{
		{"enabled", "enabled", "enabled", true, false},
		{"noop", "noop", "noop", false, true},
		{"disabled", "disabled", "disabled", false, true},
		{"empty defaults to enabled", "", "enabled", true, false},
		{"uppercase normalized", "ENABLED", "enabled", true, false},
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
			if got := cm.isDisabled(); got != tt.disabled {
				t.Errorf("isDisabled() = %v, want %v", got, tt.disabled)
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
	content, err := cm.generateCaddyfile()
	if err != nil {
		t.Fatalf("generateCaddyfile() failed: %v", err)
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
