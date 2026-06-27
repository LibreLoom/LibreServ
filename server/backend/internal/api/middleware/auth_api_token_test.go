package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// newAuthMiddlewareFixture stands up a real DB + auth service with a user and
// an API token, so the Auth/CSRF middleware can be exercised end-to-end.
func newAuthMiddlewareFixture(t *testing.T) (authSvc *auth.Service, apiToken, tokenID, userID string) {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	svc := auth.NewService(db, "testsecret", slog.Default())
	user, err := svc.Register(context.Background(), &auth.RegisterRequest{
		Username: "alice", Password: "SuperSecret123", Email: "alice@example.com",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	plaintext, rec, err := svc.CreateAPIToken(context.Background(), user.ID, "test")
	if err != nil {
		t.Fatalf("create api token: %v", err)
	}
	return svc, plaintext, rec.ID, user.ID
}

// TestAuthMiddleware_APITokenFallback verifies a bearer API token authenticates
// as its owner and is tagged auth_method=api_token (so CSRF will bypass it).
func TestAuthMiddleware_APITokenFallback(t *testing.T) {
	svc, apiToken, tokenID, userID := newAuthMiddlewareFixture(t)

	var gotUser *User
	var gotMethod string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser = GetUser(r.Context())
		gotMethod = GetAuthMethod(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	authMW := Auth(&AuthConfig{AuthService: svc})

	// API token authenticates.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/apps", nil)
	req.Header.Set("Authorization", "Bearer "+apiToken)
	authMW(inner).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("api-token request: expected 200, got %d", rec.Code)
	}
	if gotUser == nil || gotUser.ID != userID {
		t.Fatalf("api token did not authenticate as owner: %+v", gotUser)
	}
	if gotMethod != "api_token" {
		t.Fatalf("auth method = %q, want api_token", gotMethod)
	}

	// Revoked API token is rejected.
	if err := svc.RevokeAPIToken(context.Background(), userID, tokenID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/apps", nil)
	req.Header.Set("Authorization", "Bearer "+apiToken)
	authMW(inner).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked api token: expected 401, got %d", rec.Code)
	}

	// No token at all is rejected.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/apps", nil)
	authMW(inner).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: expected 401, got %d", rec.Code)
	}
}

// TestCSRF_BypassesAPIToken verifies CSRF enforcement is skipped for
// api_token-authed requests (bearer auth is immune to CSRF) while still
// requiring an X-CSRF-Token for session-authed writes.
func TestCSRF_BypassesAPIToken(t *testing.T) {
	svc, apiToken, _, _ := newAuthMiddlewareFixture(t)
	const secret = "csrfsecret"

	reached := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true; w.WriteHeader(http.StatusOK) })

	r := chi.NewRouter()
	r.Use(Auth(&AuthConfig{AuthService: svc}))
	r.Use(CSRF(secret))
	r.Post("/x", inner)

	// API-token POST with no X-CSRF-Token -> reaches the handler (bypassed).
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+apiToken)
	r.ServeHTTP(rec, req)
	if !reached {
		t.Fatalf("api-token POST should bypass CSRF and reach the handler (got %d)", rec.Code)
	}

	// Session POST with no X-CSRF-Token -> blocked by CSRF.
	reached = false
	resp, err := svc.Login(context.Background(), &auth.LoginRequest{Username: "alice", Password: "SuperSecret123"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+resp.Tokens.AccessToken)
	r.ServeHTTP(rec, req)
	if reached {
		t.Fatalf("session POST without X-CSRF-Token should be blocked (got %d)", rec.Code)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("session POST without CSRF: expected 403, got %d", rec.Code)
	}
}
