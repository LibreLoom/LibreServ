package handlers

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
)

func newTestAuthHandler(t *testing.T) (*AuthHandler, context.Context) {
	t.Helper()
	origCfg := config.Get()
	config.SetTestConfig(&config.Config{Auth: config.AuthConfig{}})
	t.Cleanup(func() { config.SetTestConfig(origCfg) })

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	svc := auth.NewService(db, "secret", slog.Default())

	// Create security service for tests
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	notifier := security.NewEmailNotifier()
	secSvc := security.NewService(db, logger, notifier)

	return NewAuthHandler(svc, secSvc, db), context.Background()
}

// mustRegisterUser creates a user via the auth service. The public register
// handler is gone (admin-add/invite-redeem replace it); in-package access to
// handler.authService lets tests set up users without the HTTP path.
func mustRegisterUser(t *testing.T, handler *AuthHandler, ctx context.Context, username, password, email string) {
	t.Helper()
	if _, err := handler.authService.Register(ctx, &auth.RegisterRequest{
		Username: username, Password: password, Email: email,
	}); err != nil {
		t.Fatalf("register %s: %v", username, err)
	}
}

func TestAuthRegisterLogin(t *testing.T) {
	handler, ctx := newTestAuthHandler(t)

	// create a user (public register is gone; admin-add/invite-redeem replace it)
	mustRegisterUser(t, handler, ctx, "bob", "Superstrongpass123", "bob@example.com")

	// login
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"username":"bob","password":"Superstrongpass123"}`))
	handler.Login(rec, req.WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("login status %d", rec.Code)
	}
	// Assert access cookie is set
	res := rec.Result()
	cookies := res.Cookies()
	var hasAccessCookie bool
	for _, c := range cookies {
		if c.Name == "libreserv_access" && c.Value != "" {
			hasAccessCookie = true
			break
		}
	}
	if !hasAccessCookie {
		t.Fatalf("expected access cookie to be set")
	}

	// Assert tokens are NOT returned in JSON
	bodyStr := rec.Body.String()
	if strings.Contains(bodyStr, "access_token") || strings.Contains(bodyStr, "refresh_token") || strings.Contains(bodyStr, `"tokens"`) {
		t.Fatalf("did not expect tokens in response body: %s", bodyStr)
	}
}

func TestMe(t *testing.T) {
	handler, ctx := newTestAuthHandler(t)

	// create a user first (public register is gone)
	mustRegisterUser(t, handler, ctx, "alice", "Superstrongpass123", "alice@example.com")

	// look up the real user ID from the service
	registeredUser, err := handler.authService.GetUserByUsername(ctx, "alice")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}

	// inject user context with the real user ID as middleware would
	user := &middleware.User{ID: registeredUser.ID, Username: "alice", Role: "user"}
	userCtx := context.WithValue(context.Background(), middleware.UserContextKey, user)
	userCtx = context.WithValue(userCtx, middleware.UserIDContextKey, user.ID)

	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil).WithContext(userCtx)
	handler.Me(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("me expected 200, got %d", rec2.Code)
	}
}

func TestMeUnauthenticated(t *testing.T) {
	handler, ctx := newTestAuthHandler(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil).WithContext(ctx)
	handler.Me(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestLogout(t *testing.T) {
	handler, ctx := newTestAuthHandler(t)

	// create a user (public register is gone)
	mustRegisterUser(t, handler, ctx, "charlie", "Superstrongpass123", "charlie@example.com")

	// inject user context as middleware would
	user := &middleware.User{ID: "charlie", Username: "charlie", Role: "user"}
	userCtx := context.WithValue(context.Background(), middleware.UserContextKey, user)
	userCtx = context.WithValue(userCtx, middleware.UserIDContextKey, user.ID)

	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil).WithContext(userCtx)
	handler.Logout(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("logout expected 200, got %d", rec2.Code)
	}
}

func TestLogoutWithoutUser(t *testing.T) {
	handler, ctx := newTestAuthHandler(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil).WithContext(ctx)
	handler.Logout(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("logout without user expected 200, got %d", rec.Code)
	}
}
