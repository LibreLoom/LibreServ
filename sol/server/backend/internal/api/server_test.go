package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	handlersauth "gt.plainskill.net/LibreLoom/Sol/internal/api/handlers/auth"
	"gt.plainskill.net/LibreLoom/Sol/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/Sol/internal/apps"
	"gt.plainskill.net/LibreLoom/Sol/internal/auth"
	"gt.plainskill.net/LibreLoom/Sol/internal/config"
	"gt.plainskill.net/LibreLoom/Sol/internal/database"
	"gt.plainskill.net/LibreLoom/Sol/internal/settings"
	"gt.plainskill.net/LibreLoom/Sol/internal/setup"
)

func TestNewServerRouterSmoke(t *testing.T) {
	orig := config.Get()
	cfg := &config.Config{
		Server: config.ServerConfig{Host: "127.0.0.1", Port: 0, Mode: "development"},
		Auth:   config.AuthConfig{JWTSecret: "test-jwt-secret-at-least-32-bytes!!", CSRFSecret: "csrf-secret"},
		Apps:   config.AppsConfig{DataPath: t.TempDir(), CatalogPath: t.TempDir()},
		CORS:   config.CORSConfig{},
		Network: config.NetworkConfig{
			Caddy:  config.CaddyConfig{Mode: "disabled"},
			Tunnel: config.TunnelConfig{},
		},
	}
	config.SetTestConfig(cfg)
	t.Cleanup(func() { config.SetTestConfig(orig) })

	db, err := database.Open(filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(db, cfg.Auth.JWTSecret, logger)
	setupSvc := setup.NewService(db)
	settingsSvc := settings.NewService(db.SQL())
	manager, err := apps.NewManager(cfg.Apps.CatalogPath, cfg.Apps.DataPath, nil, db, nil, nil, nil)
	if err != nil {
		t.Fatalf("apps manager: %v", err)
	}
	oidcHandler := handlersauth.NewOIDCHandler(db, manager, authSvc, "https://issuer.example.test", logger)

	srv := NewServer(ServerConfig{
		Host:             "127.0.0.1",
		Port:             0,
		DevMode:          true,
		DB:               db,
		AppManager:       manager,
		AuthService:      authSvc,
		SetupService:     setupSvc,
		SettingsService:  settingsSvc,
		OIDCAdminHandler: oidcHandler,
	})
	if srv == nil || srv.Router() == nil {
		t.Fatal("expected server and router")
	}

	paths := []string{
		"/health",
		"/health/live",
		"/health/ready",
		"/api/version",
		"/api/v1/setup/status",
		"/api/v1/catalog/apps",
		"/api/v1/network/probe/public-ip",
		"/api/v1/auth/login",
	}
	for _, path := range paths {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		srv.Router().ServeHTTP(rec, req)
		if rec.Code >= 500 {
			t.Fatalf("%s => %d %s", path, rec.Code, rec.Body.String())
		}
	}

	// Unauthenticated POSTs should not 500.
	for _, path := range []string{"/api/v1/auth/login", "/api/v1/auth/refresh"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		srv.Router().ServeHTTP(rec, req)
		if rec.Code >= 500 {
			t.Fatalf("POST %s => %d %s", path, rec.Code, rec.Body.String())
		}
	}

	// Who may open an app is an Admin's job. A plain account must not be
	// able to grant itself access, nor read the access list.
	plainUser := context.WithValue(context.Background(), middleware.UserContextKey, &middleware.User{
		ID:       "user-1",
		Username: "lin",
		Role:     "user",
	})
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/apps/app-1/oidc"},
		{http.MethodGet, "/api/v1/apps/app-1/oidc/access"},
		{http.MethodPost, "/api/v1/apps/app-1/oidc/access"},
		{http.MethodDelete, "/api/v1/apps/app-1/oidc/access/user-1"},
		{http.MethodGet, "/api/v1/apps/app-1/oidc/restricted"},
		{http.MethodPut, "/api/v1/apps/app-1/oidc/restricted"},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{"user_id":"user-1"}`))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(plainUser)
		srv.Router().ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s => %d, want 403", tc.method, tc.path, rec.Code)
		}
	}
}
