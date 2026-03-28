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

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
)

func newTestAuthHandler(t *testing.T) (*AuthHandler, context.Context) {
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
	svc := auth.NewService(db, "secret", slog.Default())

	// Create security service for tests
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	notifier := security.NewEmailNotifier()
	secSvc := security.NewService(db, logger, notifier)

	return NewAuthHandler(svc, secSvc), context.Background()
}

func TestAuthRegisterLogin(t *testing.T) {
	handler, ctx := newTestAuthHandler(t)

	// register
	rec := httptest.NewRecorder()
	body := `{"username":"bob","password":"Superstrongpass123","email":"bob@example.com"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewBufferString(body))
	handler.Register(rec, req.WithContext(ctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("register status %d", rec.Code)
	}

	// login
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"username":"bob","password":"Superstrongpass123"}`))
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
