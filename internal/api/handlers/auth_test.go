package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
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
	svc := auth.NewService(db, "secret")
	return NewAuthHandler(svc), context.Background()
}

func TestAuthRegisterLogin(t *testing.T) {
	handler, ctx := newTestAuthHandler(t)

	// register
	rec := httptest.NewRecorder()
	body := `{"username":"bob","password":"supersecret","email":"bob@example.com"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewBufferString(body))
	handler.Register(rec, req.WithContext(ctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("register status %d", rec.Code)
	}

	// login
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"username":"bob","password":"supersecret"}`))
	handler.Login(rec, req.WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("login status %d", rec.Code)
	}
	var resp struct {
		User   any `json:"user"`
		Tokens any `json:"tokens"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Tokens == nil {
		t.Fatalf("expected tokens")
	}
}

