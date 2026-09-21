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

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func newTestInviteHandler(t *testing.T, send func(email, token string) error) (*InviteHandler, *auth.Service, string) {
	t.Helper()
	hibpStub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(""))
	}))
	t.Cleanup(hibpStub.Close)
	hibpRangeURL = hibpStub.URL + "/range/"

	db, err := database.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	svc := auth.NewService(db, "secret", slog.Default())
	user, err := svc.Register(context.Background(), &auth.RegisterRequest{
		Username: "admin1",
		Password: "SuperSecret123",
		Email:    "admin1@example.com",
	})
	if err != nil {
		t.Fatalf("register admin: %v", err)
	}
	return NewInviteHandler(svc, send), svc, user.ID
}

func withUserIDCtx(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, middleware.UserIDContextKey, userID)
}

func TestInviteCreateGetRedeem(t *testing.T) {
	var sentEmail, sentToken string
	h, _, adminID := newTestInviteHandler(t, func(email, token string) error {
		sentEmail, sentToken = email, token
		return nil
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/invites", bytes.NewBufferString(`{"email":"a@b.com","role":"user"}`))
	h.CreateInvite(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized: got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/users/invites", bytes.NewBufferString(`{"email":"newbie@example.com","role":"user"}`))
	req = req.WithContext(withUserIDCtx(context.Background(), adminID))
	h.CreateInvite(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	if sentEmail != "newbie@example.com" || sentToken == "" {
		t.Fatalf("sendInvite not called: email=%q token=%q", sentEmail, sentToken)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/auth/invite/"+sentToken, nil)
	req = withChiURLParam(req, "token", sentToken)
	h.GetInvite(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d", rec.Code)
	}
	var got map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["valid"] != true || got["email"] != "newbie@example.com" {
		t.Fatalf("get payload: %#v", got)
	}

	rec = httptest.NewRecorder()
	body := `{"username":"newbie","password":"FreshPassword123"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/invite/"+sentToken+"/redeem", bytes.NewBufferString(body))
	req = withChiURLParam(req, "token", sentToken)
	h.RedeemInvite(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("redeem: %d %s", rec.Code, rec.Body.String())
	}
}

func TestInviteCreateRequiresSMTP(t *testing.T) {
	h, _, adminID := newTestInviteHandler(t, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/invites", bytes.NewBufferString(`{"email":"a@b.com","role":"user"}`))
	req = req.WithContext(withUserIDCtx(context.Background(), adminID))
	h.CreateInvite(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 without SMTP, got %d", rec.Code)
	}
}

func TestInviteSetSenderAndValidation(t *testing.T) {
	h, _, adminID := newTestInviteHandler(t, nil)
	called := false
	h.SetSender(func(email, token string) error { called = true; return nil })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/invites", bytes.NewBufferString(`{"email":"","role":""}`))
	req = req.WithContext(withUserIDCtx(context.Background(), adminID))
	h.CreateInvite(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty fields: got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/users/invites", bytes.NewBufferString(`not-json`))
	req = req.WithContext(withUserIDCtx(context.Background(), adminID))
	h.CreateInvite(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json: got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/users/invites", bytes.NewBufferString(`{"email":"ok@example.com","role":"user"}`))
	req = req.WithContext(withUserIDCtx(context.Background(), adminID))
	h.CreateInvite(rec, req)
	if rec.Code != http.StatusCreated || !called {
		t.Fatalf("set sender create: %d called=%v body=%s", rec.Code, called, rec.Body.String())
	}
}
