package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAllowGuessUsesDriverTransactions(t *testing.T) {
	d := testDeps(t)
	key := "email-check:203.0.113.10"
	if !allowGuess(d.DB, key, 3, 60) {
		t.Fatal("first guess should be allowed")
	}
	if !allowGuess(d.DB, key, 3, 60) {
		t.Fatal("second guess should be allowed")
	}
	if !allowGuess(d.DB, key, 3, 60) {
		t.Fatal("third guess should be allowed")
	}
	if allowGuess(d.DB, key, 3, 60) {
		t.Fatal("fourth guess should be blocked")
	}
}

func TestCheckEmailNotRateLimitedOnFirstTry(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	req := httptest.NewRequest(http.MethodPost, "/account/check-email", strings.NewReader(`{"email":"fresh@example.com"}`))
	req.RemoteAddr = "203.0.113.55:443"
	rec := httptest.NewRecorder()
	acct.CheckEmail(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "Too many tries") {
		t.Fatalf("unexpected rate limit: %s", rec.Body.String())
	}
}
