package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSPAFallback(t *testing.T) {
	called := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Admin sign-in required."}`))
	})
	spa := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><html></html>"))
	}
	handler := SPAFallback(spa)(next)

	req := httptest.NewRequest(http.MethodGet, "/admin/providers", nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if called != 0 {
		t.Fatalf("browser navigation should not reach API handler, called=%d", called)
	}
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "<!doctype html>") {
		t.Fatalf("SPA fallback = %d body=%q", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/admin/providers", nil)
	req.Header.Set("Accept", "application/json")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if called != 1 || w.Code != http.StatusUnauthorized {
		t.Fatalf("API pass-through called=%d code=%d", called, w.Code)
	}
}
