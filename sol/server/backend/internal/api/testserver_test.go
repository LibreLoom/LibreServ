package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	handlersauth "gt.plainskill.net/LibreLoom/Sol/internal/api/handlers/auth"
	"gt.plainskill.net/LibreLoom/Sol/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/Sol/internal/apps"
	"gt.plainskill.net/LibreLoom/Sol/internal/auth"
	"gt.plainskill.net/LibreLoom/Sol/internal/config"
	"gt.plainskill.net/LibreLoom/Sol/internal/database"
	"gt.plainskill.net/LibreLoom/Sol/internal/database/models"
	"gt.plainskill.net/LibreLoom/Sol/internal/settings"
	"gt.plainskill.net/LibreLoom/Sol/internal/setup"
	"gt.plainskill.net/LibreLoom/Sol/internal/storage"
)

// The Prometheus collectors are registered on the default registry, so a test
// binary may build only ONE server. Every test in this package therefore
// shares this one.
var (
	sharedServerOnce sync.Once
	sharedRouter     http.Handler
	sharedAuth       *auth.Service
	sharedDB         *database.DB
)

// testServer returns the shared router and the auth service behind it.
//
// The setup guard runs before Auth on the protected group, so a test that
// never finishes setup gets 403 from the guard and proves nothing about a
// role check. The first admin account created here is what the guard looks
// for — the same thing finishing the wizard does.
func testServer(t *testing.T) (http.Handler, *auth.Service) {
	t.Helper()

	sharedServerOnce.Do(func() {
		dir, err := os.MkdirTemp("", "sol-api-test")
		if err != nil {
			t.Fatalf("temp dir: %v", err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(dir) })

		cfg := &config.Config{
			Server: config.ServerConfig{Host: "127.0.0.1", Port: 0, Mode: "development"},
			Auth:   config.AuthConfig{JWTSecret: "test-jwt-secret-at-least-32-bytes!!", CSRFSecret: "csrf-secret"},
			Apps:   config.AppsConfig{DataPath: filepath.Join(dir, "apps"), CatalogPath: filepath.Join(dir, "catalog")},
			CORS:   config.CORSConfig{},
			Network: config.NetworkConfig{
				Caddy:  config.CaddyConfig{Mode: "disabled"},
				Tunnel: config.TunnelConfig{},
			},
		}
		config.SetTestConfig(cfg)
		// The apps manager wants both folders to exist.
		for _, sub := range []string{"apps", "catalog"} {
			if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
				t.Fatalf("mkdir %s: %v", sub, err)
			}
		}

		db, err := database.Open(filepath.Join(dir, "api.db"))
		if err != nil {
			t.Fatalf("open db: %v", err)
		}
		if err := db.Migrate(); err != nil {
			t.Fatalf("migrate: %v", err)
		}
		sharedDB = db

		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		authSvc := auth.NewService(db, cfg.Auth.JWTSecret, logger)
		sharedAuth = authSvc
		setupSvc := setup.NewService(db)
		settingsSvc := settings.NewService(db.SQL())
		manager, err := apps.NewManager(cfg.Apps.CatalogPath, cfg.Apps.DataPath, nil, db, nil, nil, nil)
		if err != nil {
			t.Fatalf("apps manager: %v", err)
		}
		oidcHandler := handlersauth.NewOIDCHandler(db, manager, authSvc, "https://issuer.example.test", logger)
		// The backup handlers read through this service, so the fixture needs a
		// real one: an admin request must reach the handler, not a nil pointer.
		backupService := storage.NewBackupService(db, nil, filepath.Join(dir, "backups"), cfg.Apps.DataPath)

		// The first account makes the setup guard let requests through.
		admin := &models.User{
			ID:           "admin-1",
			Username:     "ada",
			PasswordHash: "not-a-real-hash",
			Role:         "admin",
		}
		if err := authSvc.CreateUser(context.Background(), admin); err != nil {
			t.Fatalf("create admin: %v", err)
		}

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
			BackupService:    backupService,
		})
		if srv == nil || srv.Router() == nil {
			t.Fatal("expected server and router")
		}
		sharedRouter = srv.Router()
	})

	if sharedRouter == nil {
		t.Fatal("no server")
	}
	return sharedRouter, sharedAuth
}

// signInAs creates a user with the given role and returns a bearer token and
// a CSRF token for them. Both are real: the request goes through the same
// Auth and CSRF middleware a browser request does.
func signInAs(t *testing.T, authSvc *auth.Service, id, username, role string) (accessToken, csrfToken string) {
	t.Helper()

	user := &models.User{
		ID:           id,
		Username:     username,
		PasswordHash: "not-a-real-hash",
		Role:         role,
	}
	if err := authSvc.CreateUser(context.Background(), user); err != nil {
		t.Fatalf("create user %s: %v", username, err)
	}

	pair, err := authSvc.GenerateTokenPairForUser(context.Background(), id)
	if err != nil {
		t.Fatalf("token pair for %s: %v", username, err)
	}
	csrfToken, err = middleware.GenerateCSRF("csrf-secret", id)
	if err != nil {
		t.Fatalf("csrf token for %s: %v", username, err)
	}
	return pair.AccessToken, csrfToken
}

// do sends a request as the given user.
func do(t *testing.T, h http.Handler, method, path, accessToken, csrfToken, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	if csrfToken != "" {
		req.Header.Set("X-CSRF-Token", csrfToken)
	}
	h.ServeHTTP(rec, req)
	return rec
}
