package api

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
// shares the one that TestMain builds.
//
// TestMain owns it because the fixture outlives any single test: a
// t.Cleanup would belong to whichever test happened to build the fixture,
// and that test's end would delete the folders while the other tests were
// still using them.
var (
	sharedRouter http.Handler
	sharedAuth   *auth.Service
	sharedDB     *database.DB
	sharedDir    string
)

func TestMain(m *testing.M) {
	code, err := runTests(m)
	if err != nil {
		fmt.Fprintf(os.Stderr, "test fixture: %v\n", err)
		os.Exit(1)
	}
	os.Exit(code)
}

// runTests builds the shared server, runs the tests, and tears the fixture
// down.
func runTests(m *testing.M) (int, error) {
	dir, err := os.MkdirTemp("", "sol-api-test")
	if err != nil {
		return 0, fmt.Errorf("temp dir: %w", err)
	}
	sharedDir = dir
	defer func() { _ = os.RemoveAll(dir) }()

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
			return 0, fmt.Errorf("mkdir %s: %w", sub, err)
		}
	}

	db, err := database.Open(filepath.Join(dir, "api.db"))
	if err != nil {
		return 0, fmt.Errorf("open db: %w", err)
	}
	sharedDB = db
	defer func() { _ = db.Close() }()
	if err := db.Migrate(); err != nil {
		return 0, fmt.Errorf("migrate: %w", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(db, cfg.Auth.JWTSecret, logger)
	sharedAuth = authSvc
	setupSvc := setup.NewService(db)
	settingsSvc := settings.NewService(db.SQL())
	manager, err := apps.NewManager(cfg.Apps.CatalogPath, cfg.Apps.DataPath, nil, db, nil, nil, nil)
	if err != nil {
		return 0, fmt.Errorf("apps manager: %w", err)
	}
	oidcHandler := handlersauth.NewOIDCHandler(db, manager, authSvc, "https://issuer.example.test", logger)
	// The backup handlers read through this service, so the fixture needs a
	// real one: an admin request must reach the handler, not a nil pointer.
	backupService := storage.NewBackupService(db, nil, filepath.Join(dir, "backups"), cfg.Apps.DataPath)

	// The first account makes the setup guard let requests through — the same
	// thing finishing the wizard does.
	admin := &models.User{
		ID:           "admin-1",
		Username:     "ada",
		PasswordHash: "not-a-real-hash",
		Role:         "admin",
	}
	if err := authSvc.CreateUser(context.Background(), admin); err != nil {
		return 0, fmt.Errorf("create admin: %w", err)
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
		return 0, fmt.Errorf("expected server and router")
	}
	sharedRouter = srv.Router()

	return m.Run(), nil
}

// testServer returns the shared router and the auth service behind it.
//
// The setup guard runs before Auth on the protected group, so a test that
// never finishes setup gets 403 from the guard and proves nothing about a
// role check. The first admin account created by the fixture is what the
// guard looks for.
func testServer(t *testing.T) (http.Handler, *auth.Service) {
	t.Helper()
	if sharedRouter == nil || sharedAuth == nil {
		t.Fatal("no server: the fixture did not build")
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
