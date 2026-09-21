package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func newTestAPITokensHandler(t *testing.T) (*APITokensHandler, *auth.Service, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	svc := auth.NewService(db, "secret", slog.Default())
	user, err := svc.Register(context.Background(), &auth.RegisterRequest{
		Username: "alice", Password: "SuperSecret123", Email: "alice@example.com",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	return NewAPITokensHandler(svc), svc, user.ID
}

func ctxWithUser(userID string) context.Context {
	ctx := context.Background()
	ctx = context.WithValue(ctx, middleware.UserContextKey, &middleware.User{ID: userID, Username: "alice", Role: "user"})
	ctx = context.WithValue(ctx, middleware.UserIDContextKey, userID)
	return ctx
}

func ctxWithUserAndParam(userID, key, val string) context.Context {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, val)
	ctx := context.WithValue(context.Background(), chi.RouteCtxKey, rctx)
	ctx = context.WithValue(ctx, middleware.UserContextKey, &middleware.User{ID: userID, Username: "alice", Role: "user"})
	ctx = context.WithValue(ctx, middleware.UserIDContextKey, userID)
	return ctx
}

func TestAPITokensCRUD(t *testing.T) {
	h, svc, userID := newTestAPITokensHandler(t)

	// Create — returns plaintext once.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/api-tokens", bytes.NewBufferString(`{"name":"ci-deploy"}`))
	h.Create(rec, req.WithContext(ctxWithUser(userID)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	var created struct {
		Token    string `json:"token"`
		APIToken struct {
			ID, Name, TokenPrefix string
		} `json:"api_token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("create body: %v", err)
	}
	if created.Token == "" || created.APIToken.ID == "" || created.APIToken.Name != "ci-deploy" {
		t.Fatalf("create body mismatch: %+v", created)
	}

	// The plaintext token authenticates the user via the service (what the
	// middleware will do).
	u, err := svc.ValidateAPIToken(context.Background(), created.Token)
	if err != nil {
		t.Fatalf("validate created token: %v", err)
	}
	if u.ID != userID {
		t.Fatalf("token resolved to wrong user: %s", u.ID)
	}

	// List — one token, no hash leaked.
	rec = httptest.NewRecorder()
	h.List(rec, httptest.NewRequest(http.MethodGet, "/api/v1/api-tokens", nil).WithContext(ctxWithUser(userID)))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d", rec.Code)
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("token_hash")) {
		t.Fatalf("list must not expose token_hash: %s", rec.Body.String())
	}
	var listed struct{ Tokens []map[string]any }
	json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Tokens) != 1 {
		t.Fatalf("list: expected 1 token, got %d", len(listed.Tokens))
	}

	// Create without a name -> 400 (plain language).
	rec = httptest.NewRecorder()
	h.Create(rec, httptest.NewRequest(http.MethodPost, "/api/v1/api-tokens", bytes.NewBufferString(`{"name":"  "}`)).WithContext(ctxWithUser(userID)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty-name: expected 400, got %d", rec.Code)
	}

	// Revoke.
	rec = httptest.NewRecorder()
	h.Revoke(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/api-tokens/"+created.APIToken.ID, nil).
		WithContext(ctxWithUserAndParam(userID, "id", created.APIToken.ID)))
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	// Revoked token no longer authenticates.
	if _, err := svc.ValidateAPIToken(context.Background(), created.Token); err != auth.ErrAPITokenRevoked {
		t.Fatalf("expected ErrAPITokenRevoked after revoke, got %v", err)
	}

	// Revoke a non-existent / someone else's token -> 404.
	rec = httptest.NewRecorder()
	h.Revoke(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/api-tokens/bogus", nil).
		WithContext(ctxWithUserAndParam(userID, "id", "bogus")))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("revoke bogus: expected 404, got %d", rec.Code)
	}
}
