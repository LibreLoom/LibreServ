package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func hstsForHost(t *testing.T, host string) string {
	t.Helper()
	mw := SecurityHeaders()
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = host
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	return rr.Header().Get("Strict-Transport-Security")
}

func TestHSTSHostMatching(t *testing.T) {
	const wantHSTS = "max-age=31536000; includeSubDomains"

	if got := hstsForHost(t, "notlocalhost.example"); got != wantHSTS {
		t.Fatalf("notlocalhost.example should get HSTS, got %q", got)
	}
	if got := hstsForHost(t, "localhost:3000"); got != "" {
		t.Fatalf("localhost:3000 should not get HSTS, got %q", got)
	}
	if got := hstsForHost(t, "example.com"); got != wantHSTS {
		t.Fatalf("example.com should get HSTS, got %q", got)
	}
}
