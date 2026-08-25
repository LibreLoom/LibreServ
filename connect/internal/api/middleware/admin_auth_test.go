package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func TestAdminAuthStaticTokenIsCaseSensitive(t *testing.T) {
	db := database.OpenTestDB(t)
	config.C.Auth.AdminTokenSecret = "admin-test-token"
	t.Cleanup(func() { config.C.Auth.AdminTokenSecret = "" })

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := AdminAuth(db)(ok)

	req := httptest.NewRequest(http.MethodGet, "/admin/devices", nil)
	req.Header.Set("Authorization", "Bearer ADMIN-TEST-TOKEN")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401 for a case-folded static token", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/admin/devices", nil)
	req.Header.Set("Authorization", "Bearer admin-test-token")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status=%d, want 204 for the exact static token: %s", w.Code, w.Body.String())
	}
}

func TestAdminAuthRateLimitsFailedGuesses(t *testing.T) {
	db := database.OpenTestDB(t)
	config.C.Auth.AdminTokenSecret = "admin-test-token"
	t.Cleanup(func() { config.C.Auth.AdminTokenSecret = "" })

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := AdminAuth(db)(ok)

	var last int
	for i := 0; i < 12; i++ {
		req := httptest.NewRequest(http.MethodGet, "/admin/devices", nil)
		req.RemoteAddr = "198.51.100.20:9"
		req.Header.Set("Authorization", "Bearer wrong-token")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		last = w.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("last status=%d, want 429 after repeated failed admin auth", last)
	}
}
