package apps

import (
	"os"
	"path/filepath"
	"testing"
)

func setupTestCatalog(t *testing.T) (*Catalog, string) {
	t.Helper()
	tmpDir := t.TempDir()
	builtinDir := filepath.Join(tmpDir, "builtin")

	// Create builtin directory
	if err := os.MkdirAll(builtinDir, 0755); err != nil {
		t.Fatalf("Failed to create builtin directory: %v", err)
	}

	// Create test app 1
	app1Dir := filepath.Join(builtinDir, "testapp1")
	if err := os.MkdirAll(app1Dir, 0755); err != nil {
		t.Fatalf("Failed to create app1 directory: %v", err)
	}

	app1YAML := `id: testapp1
name: Test App 1
description: A test application
version: 1.0.0
category: productivity
icon: https://example.com/icon.png
website: https://example.com
repository: https://github.com/example/testapp1
featured: true

deployment:
  compose_file: docker-compose.yml
  ports:
    - host: 8080
      container: 8080
      protocol: tcp
  volumes:
    - name: data
      mount_path: /data
  restart_policy: unless-stopped

configuration:
  - name: port
    label: Port
    description: HTTP port
    type: port
    default: 8080
    required: true

health_check:
  type: http
  endpoint: /health
  port: 8080
  interval: 30s
  timeout: 10s
  retries: 3

requirements:
  min_ram: "512M"
  min_cpu: 0.5
  min_disk: "1G"
  arch:
    - amd64
    - arm64

updates:
  strategy: notify
  backup_before_update: true
  allow_downgrade: false
`

	if err := os.WriteFile(filepath.Join(app1Dir, "app.yaml"), []byte(app1YAML), 0644); err != nil {
		t.Fatalf("Failed to write app1 yaml: %v", err)
	}

	// Create test app 2
	app2Dir := filepath.Join(builtinDir, "testapp2")
	if err := os.MkdirAll(app2Dir, 0755); err != nil {
		t.Fatalf("Failed to create app2 directory: %v", err)
	}

	app2YAML := `id: testapp2
name: Test App 2
description: Another test application
version: 2.0.0
category: development
icon: https://example.com/icon2.png
website: https://example.com/app2
repository: https://github.com/example/testapp2
featured: false

deployment:
  image: testapp2:latest
  ports:
    - host: 9090
      container: 9090
      protocol: tcp
  restart_policy: always

configuration:
  - name: api_port
    label: API Port
    description: API port
    type: port
    default: 9090
    required: true

health_check:
  type: tcp
  port: 9090
  interval: 30s
  timeout: 5s
  retries: 3

requirements:
  min_ram: "256M"
  min_cpu: 0.25
  min_disk: "500M"
  arch:
    - amd64

updates:
  strategy: auto
  backup_before_update: false
  allow_downgrade: true
`

	if err := os.WriteFile(filepath.Join(app2Dir, "app.yaml"), []byte(app2YAML), 0644); err != nil {
		t.Fatalf("Failed to write app2 yaml: %v", err)
	}

	catalog, err := NewCatalog(tmpDir)
	if err != nil {
		t.Fatalf("Failed to create catalog: %v", err)
	}

	return catalog, tmpDir
}

func TestCatalog_Load(t *testing.T) {
	catalog, _ := setupTestCatalog(t)

	if catalog.Count() != 2 {
		t.Errorf("Expected 2 apps, got %d", catalog.Count())
	}
}

func TestCatalog_GetApp(t *testing.T) {
	catalog, _ := setupTestCatalog(t)

	tests := []struct {
		name    string
		appID   string
		wantErr bool
	}{
		{"existing app 1", "testapp1", false},
		{"existing app 2", "testapp2", false},
		{"non-existent app", "nonexistent", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app, err := catalog.GetApp(tt.appID)
			if tt.wantErr {
				if err == nil {
					t.Error("Expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Errorf("GetApp() failed: %v", err)
				return
			}

			if app.ID != tt.appID {
				t.Errorf("Expected app ID %s, got %s", tt.appID, app.ID)
			}
		})
	}
}

func TestCatalog_ListApps(t *testing.T) {
	catalog, _ := setupTestCatalog(t)

	tests := []struct {
		name      string
		filters   CatalogFilters
		wantCount int
	}{
		{"no filters", CatalogFilters{}, 2},
		{"category productivity", CatalogFilters{Category: "productivity"}, 1},
		{"category development", CatalogFilters{Category: "development"}, 1},
		{"featured only", CatalogFilters{Featured: true}, 1},
		{"search test", CatalogFilters{Search: "test"}, 2},
		{"search app 1", CatalogFilters{Search: "App 1"}, 1},
		{"search app 2", CatalogFilters{Search: "App 2"}, 1},
		{"search productivity", CatalogFilters{Search: "productivity"}, 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			apps := catalog.ListApps(tt.filters)
			if len(apps) != tt.wantCount {
				t.Errorf("Expected %d apps, got %d", tt.wantCount, len(apps))
			}
		})
	}
}

func TestCatalog_GetCategories(t *testing.T) {
	catalog, _ := setupTestCatalog(t)

	categories := catalog.GetCategories()
	if len(categories) != 2 {
		t.Errorf("Expected 2 categories, got %d", len(categories))
	}

	// Check both categories are present
	hasProductivity := false
	hasDevelopment := false
	for _, cat := range categories {
		if cat == "productivity" {
			hasProductivity = true
		}
		if cat == "development" {
			hasDevelopment = true
		}
	}

	if !hasProductivity {
		t.Error("Missing 'productivity' category")
	}
	if !hasDevelopment {
		t.Error("Missing 'development' category")
	}
}

func TestCatalog_Refresh(t *testing.T) {
	catalog, tmpDir := setupTestCatalog(t)

	initialCount := catalog.Count()

	// Add a new app
	app3Dir := filepath.Join(tmpDir, "builtin", "testapp3")
	if err := os.MkdirAll(app3Dir, 0755); err != nil {
		t.Fatalf("Failed to create app3 directory: %v", err)
	}

	app3YAML := `id: testapp3
name: Test App 3
description: Third test application
version: 3.0.0
category: utility
icon: https://example.com/icon3.png
website: https://example.com/app3
repository: https://github.com/example/testapp3
featured: false

deployment:
  image: testapp3:latest

configuration: []

health_check:
  type: tcp
  port: 3000
  interval: 30s
  timeout: 5s
  retries: 3

requirements:
  min_ram: "128M"
  min_cpu: 0.1
  min_disk: "100M"
  arch:
    - amd64

updates:
  strategy: notify
  backup_before_update: true
  allow_downgrade: false
`

	if err := os.WriteFile(filepath.Join(app3Dir, "app.yaml"), []byte(app3YAML), 0644); err != nil {
		t.Fatalf("Failed to write app3 yaml: %v", err)
	}

	// Refresh catalog
	if err := catalog.Refresh(); err != nil {
		t.Fatalf("Refresh() failed: %v", err)
	}

	if catalog.Count() != initialCount+1 {
		t.Errorf("Expected %d apps after refresh, got %d", initialCount+1, catalog.Count())
	}

	// Verify new app is loaded
	app, err := catalog.GetApp("testapp3")
	if err != nil {
		t.Errorf("Failed to get newly added app: %v", err)
	}
	if app.Name != "Test App 3" {
		t.Errorf("Expected app name 'Test App 3', got %s", app.Name)
	}
}

func TestCatalog_GetComposeFilePath(t *testing.T) {
	catalog, _ := setupTestCatalog(t)

	tests := []struct {
		name    string
		appID   string
		wantErr bool
	}{
		{"app with compose file", "testapp1", false},
		{"app with image only", "testapp2", false},
		{"non-existent app", "nonexistent", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, err := catalog.GetComposeFilePath(tt.appID)
			if tt.wantErr {
				if err == nil {
					t.Error("Expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Errorf("GetComposeFilePath() failed: %v", err)
				return
			}

			if path == "" {
				t.Error("Expected non-empty path")
			}
		})
	}
}

func TestCatalog_InvalidApp(t *testing.T) {
	tmpDir := t.TempDir()
	builtinDir := filepath.Join(tmpDir, "builtin")

	// Create builtin directory
	if err := os.MkdirAll(builtinDir, 0755); err != nil {
		t.Fatalf("Failed to create builtin directory: %v", err)
	}

	// Create invalid app (missing required fields)
	appDir := filepath.Join(builtinDir, "invalidapp")
	if err := os.MkdirAll(appDir, 0755); err != nil {
		t.Fatalf("Failed to create app directory: %v", err)
	}

	invalidYAML := `id: invalidapp
name: ""
description: ""
`

	if err := os.WriteFile(filepath.Join(appDir, "app.yaml"), []byte(invalidYAML), 0644); err != nil {
		t.Fatalf("Failed to write yaml: %v", err)
	}

	// Catalog load should fail
	_, err := NewCatalog(tmpDir)
	if err == nil {
		t.Error("Expected error when loading invalid app, got nil")
	}
}

func TestCatalog_NoComposeNoImage(t *testing.T) {
	tmpDir := t.TempDir()
	builtinDir := filepath.Join(tmpDir, "builtin")

	// Create builtin directory
	if err := os.MkdirAll(builtinDir, 0755); err != nil {
		t.Fatalf("Failed to create builtin directory: %v", err)
	}

	// Create app with neither compose_file nor image
	appDir := filepath.Join(builtinDir, "nocomposenoimage")
	if err := os.MkdirAll(appDir, 0755); err != nil {
		t.Fatalf("Failed to create app directory: %v", err)
	}

	invalidYAML := `id: nocomposenoimage
name: No Compose No Image
description: An app without compose or image
version: 1.0.0
category: utility
icon: https://example.com/icon.png
website: https://example.com
repository: https://github.com/example/app
featured: false

deployment:
  ports:
    - host: 8080
      container: 8080
      protocol: tcp

configuration: []

health_check:
  type: tcp
  port: 8080
  interval: 30s
  timeout: 5s
  retries: 3

requirements:
  min_ram: "128M"
  min_cpu: 0.1
  min_disk: "100M"
  arch:
    - amd64

updates:
  strategy: notify
  backup_before_update: true
  allow_downgrade: false
`

	if err := os.WriteFile(filepath.Join(appDir, "app.yaml"), []byte(invalidYAML), 0644); err != nil {
		t.Fatalf("Failed to write yaml: %v", err)
	}

	// Catalog load should fail
	_, err := NewCatalog(tmpDir)
	if err == nil {
		t.Error("Expected error when loading app without compose_file or image, got nil")
	}
}

func TestCatalog_EmptyCatalog(t *testing.T) {
	tmpDir := t.TempDir()

	// Don't create builtin directory - should handle gracefully or fail
	catalog, err := NewCatalog(tmpDir)
	if err != nil {
		// Expected: catalog creation fails when catalog path doesn't exist
		if catalog != nil {
			t.Error("Expected nil catalog when creation fails")
		}
		return
	}
	// Alternative: catalog is created but empty
	if catalog != nil && catalog.Count() != 0 {
		t.Errorf("Expected empty catalog, got %d apps", catalog.Count())
	}
}

func TestAppDefinition_Type(t *testing.T) {
	catalog, _ := setupTestCatalog(t)

	app, err := catalog.GetApp("testapp1")
	if err != nil {
		t.Fatalf("GetApp() failed: %v", err)
	}

	if app.Type != AppTypeBuiltin {
		t.Errorf("Expected app type %s, got %s", AppTypeBuiltin, app.Type)
	}
}

func TestAppDefinition_Featured(t *testing.T) {
	catalog, _ := setupTestCatalog(t)

	// Get featured app
	app1, err := catalog.GetApp("testapp1")
	if err != nil {
		t.Fatalf("GetApp() failed: %v", err)
	}
	if !app1.Featured {
		t.Error("Expected testapp1 to be featured")
	}

	// Get non-featured app
	app2, err := catalog.GetApp("testapp2")
	if err != nil {
		t.Fatalf("GetApp() failed: %v", err)
	}
	if app2.Featured {
		t.Error("Expected testapp2 to not be featured")
	}
}

func TestCatalog_SortingFeaturedFirst(t *testing.T) {
	catalog, _ := setupTestCatalog(t)

	apps := catalog.ListApps(CatalogFilters{})

	// First app should be featured
	if len(apps) > 0 && !apps[0].Featured {
		t.Error("Expected first app to be featured (sorted)")
	}
}
