package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func seedRequest(t *testing.T, remoteAddr, seedToken string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"email":    "admin@example.com",
		"password": "correct-horse-battery",
		"name":     "Admin",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/admin/seed", bytes.NewReader(body))
	req.RemoteAddr = remoteAddr
	if seedToken != "" {
		req.Header.Set("X-Seed-Token", seedToken)
	}
	w := httptest.NewRecorder()
	NewAdminAuthHandler(database.OpenTestDB(t)).SeedAdmin(w, req)
	return w
}

func TestSeedAdminRejectsRemoteWithoutToken(t *testing.T) {
	config.C.Auth.AdminSeedToken = ""
	t.Cleanup(func() { config.C.Auth.AdminSeedToken = "" })

	if w := seedRequest(t, "203.0.113.5:40000", ""); w.Code != http.StatusForbidden {
		t.Fatalf("remote seed without token: got %d, want 403", w.Code)
	}
}

func TestSeedAdminAllowsLoopbackWithoutToken(t *testing.T) {
	config.C.Auth.AdminSeedToken = ""
	t.Cleanup(func() { config.C.Auth.AdminSeedToken = "" })

	if w := seedRequest(t, "127.0.0.1:40000", ""); w.Code != http.StatusOK {
		t.Fatalf("loopback seed: got %d (%s), want 200", w.Code, w.Body.String())
	}
}

func TestSeedAdminRequiresMatchingToken(t *testing.T) {
	config.C.Auth.AdminSeedToken = "bootstrap-secret"
	t.Cleanup(func() { config.C.Auth.AdminSeedToken = "" })

	if w := seedRequest(t, "203.0.113.5:40000", "wrong"); w.Code != http.StatusForbidden {
		t.Fatalf("wrong token: got %d, want 403", w.Code)
	}
	// Loopback no longer bypasses the check once a token is configured.
	if w := seedRequest(t, "127.0.0.1:40000", ""); w.Code != http.StatusForbidden {
		t.Fatalf("missing token from loopback: got %d, want 403", w.Code)
	}
	if w := seedRequest(t, "203.0.113.5:40000", "bootstrap-secret"); w.Code != http.StatusOK {
		t.Fatalf("valid token: got %d (%s), want 200", w.Code, w.Body.String())
	}
}

func TestSeedAdminRejectsSecondSeed(t *testing.T) {
	config.C.Auth.AdminSeedToken = ""
	t.Cleanup(func() { config.C.Auth.AdminSeedToken = "" })

	db := database.OpenTestDB(t)
	h := NewAdminAuthHandler(db)
	body, err := json.Marshal(map[string]string{"email": "a@example.com", "password": "correct-horse-battery"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	first := httptest.NewRequest(http.MethodPost, "/admin/seed", bytes.NewReader(body))
	first.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	h.SeedAdmin(w, first)
	if w.Code != http.StatusOK {
		t.Fatalf("first seed: got %d (%s), want 200", w.Code, w.Body.String())
	}

	body2, err := json.Marshal(map[string]string{"email": "b@example.com", "password": "correct-horse-battery"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	second := httptest.NewRequest(http.MethodPost, "/admin/seed", bytes.NewReader(body2))
	second.RemoteAddr = "127.0.0.1:1234"
	w2 := httptest.NewRecorder()
	h.SeedAdmin(w2, second)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("second seed: got %d (%s), want 403", w2.Code, w2.Body.String())
	}
}
