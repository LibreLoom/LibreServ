package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
)

func TestCSRFGetToken(t *testing.T) {
	h := NewCSRFHandler("test-secret")

	user := &middleware.User{ID: "user-1", Username: "testuser", Role: "admin"}
	ctx := context.WithValue(context.Background(), middleware.UserContextKey, user)
	ctx = context.WithValue(ctx, middleware.UserIDContextKey, user.ID)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/csrf", nil).WithContext(ctx)
	h.GetToken(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestCSRFGetTokenUnauthenticated(t *testing.T) {
	h := NewCSRFHandler("test-secret")

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/csrf", nil)
	h.GetToken(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestCSRFGetTokenNoSecret(t *testing.T) {
	h := NewCSRFHandler("")

	user := &middleware.User{ID: "user-1", Username: "testuser", Role: "admin"}
	ctx := context.WithValue(context.Background(), middleware.UserContextKey, user)
	ctx = context.WithValue(ctx, middleware.UserIDContextKey, user.ID)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/csrf", nil).WithContext(ctx)
	h.GetToken(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rr.Code)
	}
}
