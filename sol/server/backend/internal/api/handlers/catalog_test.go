package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func newTestCatalogHandler(t *testing.T) *CatalogHandler {
	t.Helper()

	origCfg := config.Get()
	config.SetTestConfig(&config.Config{
		Server: config.ServerConfig{
			Port: 8080,
		},
	})
	t.Cleanup(func() {
		config.SetTestConfig(origCfg)
	})

	dir := t.TempDir()

	appDir := filepath.Join(dir, "apps", "testapp")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	appYAML := `id: testapp
name: Test App
description: A test application
version: "1.0"
category: productivity
deployment:
  image: testapp:latest
access_model: internal
`
	if err := os.WriteFile(filepath.Join(appDir, "app.yaml"), []byte(appYAML), 0o644); err != nil {
		t.Fatalf("write app.yaml: %v", err)
	}

	// Create a second app for category testing
	app2Dir := filepath.Join(dir, "apps", "anotherapp")
	if err := os.MkdirAll(app2Dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	app2YAML := `id: anotherapp
name: Another App
description: Another test application
version: "2.0"
category: development
deployment:
  image: anotherapp:latest
access_model: external
`
	if err := os.WriteFile(filepath.Join(app2Dir, "app.yaml"), []byte(app2YAML), 0o644); err != nil {
		t.Fatalf("write app2.yaml: %v", err)
	}

	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	manager, err := apps.NewManager(dir, dir, nil, db, nil, nil, nil)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	return NewCatalogHandler(manager)
}

func TestCatalogListApps(t *testing.T) {
	h := newTestCatalogHandler(t)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog/apps", nil)
	h.ListApps(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestCatalogListAppsWithFilters(t *testing.T) {
	h := newTestCatalogHandler(t)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog/apps?category=productivity", nil)
	h.ListApps(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestCatalogGetApp(t *testing.T) {
	h := newTestCatalogHandler(t)

	r := chi.NewRouter()
	r.Get("/api/v1/catalog/apps/{appId}", h.GetApp)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog/apps/testapp", nil)
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestCatalogGetAppNotFound(t *testing.T) {
	h := newTestCatalogHandler(t)

	r := chi.NewRouter()
	r.Get("/api/v1/catalog/apps/{appId}", h.GetApp)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog/apps/nonexistent", nil)
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func TestCatalogGetAppNoID(t *testing.T) {
	h := newTestCatalogHandler(t)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog/apps/", nil)
	h.GetApp(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}

func TestCatalogGetCategories(t *testing.T) {
	h := newTestCatalogHandler(t)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog/categories", nil)
	h.GetCategories(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestCatalogGetAppFeatures(t *testing.T) {
	h := newTestCatalogHandler(t)

	r := chi.NewRouter()
	r.Get("/api/v1/catalog/apps/{appId}/features", h.GetAppFeatures)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog/apps/testapp/features", nil)
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestCatalogGetAppFeaturesNotFound(t *testing.T) {
	h := newTestCatalogHandler(t)

	r := chi.NewRouter()
	r.Get("/api/v1/catalog/apps/{appId}/features", h.GetAppFeatures)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog/apps/nonexistent/features", nil)
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}
