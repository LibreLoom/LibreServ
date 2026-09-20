package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func withAccount(acctH AccountHandler, next http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	acctH.AccountAuth(http.HandlerFunc(next)).ServeHTTP(rec, req)
	return rec
}

func withVerifiedAccount(acctH AccountHandler, next http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	acctH.AccountAuth(acctH.RequireVerifiedEmail(http.HandlerFunc(next))).ServeHTTP(rec, req)
	return rec
}

func registerAccount(t *testing.T, acctH AccountHandler, email string) *http.Cookie {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/account/register", bytes.NewBufferString(`{"email":"`+email+`","password":"hunter22hunter1"}`))
	rec := httptest.NewRecorder()
	acctH.Register(rec, req)
	if rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("register %s: %d %s", email, rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == "luna_connect_session" {
			return c
		}
	}
	t.Fatal("no session cookie")
	return nil
}

func registerUnverifiedAccount(t *testing.T, acctH AccountHandler, email string) *http.Cookie {
	return registerAccount(t, acctH, email)
}

func testOnboarding(t *testing.T) (OnboardingHandler, AccountHandler, DeviceHandler) {
	t.Helper()
	d := testDeps(t)
	return OnboardingHandler{Deps: d}, AccountHandler{Deps: d}, DeviceHandler{Deps: d}
}

func verifyEmailFor(t *testing.T, acctH AccountHandler, email string) {
	t.Helper()
	if _, err := acctH.DB.Exec(`UPDATE accounts SET email_verified = 1 WHERE email = ?`, email); err != nil {
		t.Fatal(err)
	}
}

func withChiParam(r *http.Request, key, val string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, val)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}
