package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

type testEnv struct {
	db       *database.DB
	authSvc  *auth.Service
	setupSvc *setup.Service
	secSvc   *security.Service
	setupH   *handlers.SetupHandler
	authH    *handlers.AuthHandler
	usersH   *handlers.UsersHandler
	ctx      context.Context
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	jwtSecret := "integration-test-jwt-secret-key-1234567890abcdef"
	authSvc := auth.NewService(db, jwtSecret, slog.Default())
	setupSvc := setup.NewService(db)
	if _, err := setupSvc.Ensure(context.Background()); err != nil {
		t.Fatalf("ensure setup state: %v", err)
	}

	logger := newTestLogger()
	notifier := security.NewEmailNotifier()
	secSvc := security.NewService(db, logger, notifier)

	setupH := handlers.NewSetupHandler(authSvc, setupSvc, (*docker.Client)(nil), nil, nil, nil)
	authH := handlers.NewAuthHandler(authSvc, secSvc)
	usersH := handlers.NewUsersHandler(authSvc)

	return &testEnv{
		db:       db,
		authSvc:  authSvc,
		setupSvc: setupSvc,
		secSvc:   secSvc,
		setupH:   setupH,
		authH:    authH,
		usersH:   usersH,
		ctx:      context.Background(),
	}
}

type testLogger struct{}

func newTestLogger() *testLogger { return &testLogger{} }

func (l *testLogger) Info(msg string, args ...any)  {}
func (l *testLogger) Error(msg string, args ...any) {}
func (l *testLogger) Debug(msg string, args ...any) {}
func (l *testLogger) Warn(msg string, args ...any)  {}

type setupResponse struct {
	Message string          `json:"message"`
	User    json.RawMessage `json:"user"`
	Tokens  struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresAt    int64  `json:"expires_at"`
	} `json:"tokens"`
}

type loginResponse struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Email    string `json:"email"`
	Role     string `json:"role"`
}

type userListResponse struct {
	Data       []map[string]interface{} `json:"data"`
	Pagination struct {
		TotalItems int64 `json:"total_items"`
	} `json:"pagination"`
}

func TestFullUserFlow(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	env := newTestEnv(t)
	_ = os.Getenv("HOME") // ensure env is loaded

	var accessToken string

	// Step 1: Check setup status (should be pending)
	t.Run("setup_status_pending", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil)
		env.setupH.GetStatus(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusOK {
			t.Fatalf("status code %d, want 200", rec.Code)
		}
		var resp map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		state, ok := resp["setup_state"].(map[string]interface{})
		if !ok {
			t.Fatal("missing setup_state")
		}
		if state["status"] != "pending" {
			t.Errorf("status = %v, want pending", state["status"])
		}
	})

	// Step 2: Complete setup (creates admin)
	t.Run("complete_setup", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := `{"admin_username":"admin","admin_password":"Superstrongpass123","admin_email":"admin@example.com"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/setup/complete", bytes.NewBufferString(body))
		env.setupH.CompleteSetup(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusCreated {
			t.Fatalf("complete setup status %d, want 201. Body: %s", rec.Code, rec.Body.String())
		}

		var resp setupResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if resp.Message != "setup complete" {
			t.Errorf("message = %q, want 'setup complete'", resp.Message)
		}
		if resp.Tokens.AccessToken == "" {
			t.Error("expected access token in setup response")
		}
		accessToken = resp.Tokens.AccessToken
	})

	// Step 3: Setup should now be complete (idempotent check)
	t.Run("setup_status_complete", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil)
		env.setupH.GetStatus(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusOK {
			t.Fatalf("status code %d", rec.Code)
		}
		var resp map[string]interface{}
		json.Unmarshal(rec.Body.Bytes(), &resp)
		state := resp["setup_state"].(map[string]interface{})
		if state["status"] != "complete" {
			t.Errorf("status = %v, want complete", state["status"])
		}
	})

	// Step 4: Cannot complete setup again
	t.Run("setup_blocked_after_complete", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := `{"admin_username":"hacker","admin_password":"Superstrongpass123"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/setup/complete", bytes.NewBufferString(body))
		env.setupH.CompleteSetup(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", rec.Code)
		}
	})

	// Step 5: Login as admin
	t.Run("login_as_admin", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := `{"username":"admin","password":"Superstrongpass123"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(body))
		env.authH.Login(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusOK {
			t.Fatalf("login status %d, body: %s", rec.Code, rec.Body.String())
		}

		var resp loginResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if resp.Username != "admin" {
			t.Errorf("username = %q, want admin", resp.Username)
		}
		if resp.Role != "admin" {
			t.Errorf("role = %q, want admin", resp.Role)
		}

		// Verify access cookie is set
		cookies := rec.Result().Cookies()
		var hasAccessCookie bool
		for _, c := range cookies {
			if c.Name == "libreserv_access" && c.Value != "" {
				hasAccessCookie = true
				break
			}
		}
		if !hasAccessCookie {
			t.Error("expected libreserv_access cookie")
		}
	})

	// Step 6: Login with wrong password fails
	t.Run("login_wrong_password", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := `{"username":"admin","password":"wrongpassword123"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(body))
		env.authH.Login(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", rec.Code)
		}
	})

	// Step 7: Register a second user
	t.Run("register_second_user", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := `{"username":"alice","password":"AnotherStrong123","email":"alice@example.com"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewBufferString(body))
		env.authH.Register(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusCreated {
			t.Fatalf("register status %d, body: %s", rec.Code, rec.Body.String())
		}
	})

	// Step 8: Cannot register duplicate user
	t.Run("register_duplicate", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := `{"username":"alice","password":"AnotherStrong123","email":"alice2@example.com"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewBufferString(body))
		env.authH.Register(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusConflict {
			t.Fatalf("expected 409, got %d", rec.Code)
		}
	})

	// Step 9: List users (should have admin + alice)
	t.Run("list_users", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/users", nil)
		env.usersH.ListUsers(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusOK {
			t.Fatalf("list users status %d", rec.Code)
		}

		var resp userListResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Pagination.TotalItems != 2 {
			t.Errorf("expected 2 users, got %d", resp.Pagination.TotalItems)
		}

		// Verify both users are present
		usernames := make(map[string]bool)
		for _, u := range resp.Data {
			usernames[u["username"].(string)] = true
		}
		if !usernames["admin"] {
			t.Error("admin user not found in list")
		}
		if !usernames["alice"] {
			t.Error("alice user not found in list")
		}
	})

	// Step 10: Login as alice
	t.Run("login_as_alice", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := `{"username":"alice","password":"AnotherStrong123"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(body))
		env.authH.Login(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusOK {
			t.Fatalf("login as alice status %d, body: %s", rec.Code, rec.Body.String())
		}

		var resp loginResponse
		json.Unmarshal(rec.Body.Bytes(), &resp)
		if resp.Username != "alice" {
			t.Errorf("username = %q, want alice", resp.Username)
		}
		if resp.Role != "user" {
			t.Errorf("role = %q, want user", resp.Role)
		}
	})

	// Step 11: Verify setup token no longer works
	t.Run("setup_token_no_longer_valid", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := `{"admin_username":"hacker","admin_password":"Superstrongpass123"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/setup/complete", bytes.NewBufferString(body))
		env.setupH.CompleteSetup(rec, req.WithContext(env.ctx))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", rec.Code)
		}
	})

	// Verify access token from setup was obtained
	if accessToken == "" {
		t.Error("access token should have been obtained during setup")
	}
}
