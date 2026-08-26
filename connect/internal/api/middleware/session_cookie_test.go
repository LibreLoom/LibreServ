package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
)

func TestSetPortalSessionCookieFlags(t *testing.T) {
	prevURL := config.C.Server.BaseURL
	prevTTL := config.C.Auth.SessionTTLHours
	t.Cleanup(func() {
		config.C.Server.BaseURL = prevURL
		config.C.Auth.SessionTTLHours = prevTTL
	})

	config.C.Server.BaseURL = "https://connect.example.com"
	config.C.Auth.SessionTTLHours = 24

	rec := httptest.NewRecorder()
	SetPortalSessionCookie(rec, "acct_test_token")
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("got %d cookies, want 1", len(cookies))
	}
	c := cookies[0]
	if c.Name != portalSessionCookie {
		t.Fatalf("name=%q", c.Name)
	}
	if !c.HttpOnly {
		t.Fatal("expected HttpOnly")
	}
	if !c.Secure {
		t.Fatal("expected Secure when base_url is https")
	}
	if c.SameSite != http.SameSiteLaxMode {
		t.Fatalf("SameSite=%v, want Lax", c.SameSite)
	}
	if c.Path != "/" {
		t.Fatalf("Path=%q", c.Path)
	}
	if c.MaxAge != 24*3600 {
		t.Fatalf("MaxAge=%d", c.MaxAge)
	}

	config.C.Server.BaseURL = "http://localhost:8080"
	rec = httptest.NewRecorder()
	SetPortalSessionCookie(rec, "tok")
	c = rec.Result().Cookies()[0]
	if c.Secure {
		t.Fatal("Secure must be false for http base_url")
	}
}

func TestClearPortalSessionCookie(t *testing.T) {
	rec := httptest.NewRecorder()
	ClearPortalSessionCookie(rec)
	c := rec.Result().Cookies()[0]
	if c.MaxAge != -1 {
		t.Fatalf("MaxAge=%d, want -1", c.MaxAge)
	}
	if !c.HttpOnly {
		t.Fatal("expected HttpOnly on clear")
	}
}

func TestOriginAllowed(t *testing.T) {
	prev := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = prev })
	config.C.Server.BaseURL = "https://connect.example.com"

	req := httptest.NewRequest(http.MethodPost, "/portal/devices", nil)
	if !OriginAllowed(req) {
		t.Fatal("empty origin should be allowed")
	}
	req.Header.Set("Origin", "https://evil.example")
	if OriginAllowed(req) {
		t.Fatal("evil origin should be rejected")
	}
	req.Header.Set("Origin", "https://connect.example.com")
	if !OriginAllowed(req) {
		t.Fatal("matching base URL origin should be allowed")
	}
	req.Header.Set("Origin", "https://connect.example.com/")
	if !OriginAllowed(req) {
		t.Fatal("origin with trailing path slash should still match host")
	}
}

func TestOriginAllowedFallsBackToRequestHost(t *testing.T) {
	prev := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = prev })
	config.C.Server.BaseURL = ""

	req := httptest.NewRequest(http.MethodPost, "http://portal.local/portal/me", nil)
	req.Host = "portal.local"
	req.Header.Set("Origin", "http://portal.local")
	if !OriginAllowed(req) {
		t.Fatal("origin matching request host should be allowed when base_url empty")
	}
	req.Header.Set("Origin", "http://evil.local")
	if OriginAllowed(req) {
		t.Fatal("mismatched host should be rejected")
	}
}

func TestPortalOriginCheck(t *testing.T) {
	prev := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = prev })
	config.C.Server.BaseURL = "https://connect.example.com"

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := PortalOriginCheck(ok)

	req := httptest.NewRequest(http.MethodPost, "/portal/cancel", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "origin not allowed") {
		t.Fatalf("body=%s", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/portal/cancel", nil)
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Authorization", "Bearer some-token")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("bearer status=%d, want 204", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/portal/me", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("GET status=%d, want 204", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/portal/cancel", nil)
	req.Header.Set("Origin", "https://connect.example.com")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("good origin status=%d, want 204", rec.Code)
	}
}

func TestCookieSecure(t *testing.T) {
	prev := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = prev })
	config.C.Server.BaseURL = "https://x.example"
	if !config.CookieSecure() {
		t.Fatal("https base_url should be secure")
	}
	config.C.Server.BaseURL = "http://x.example"
	if config.CookieSecure() {
		t.Fatal("http base_url should not be secure")
	}
}

func TestAttachPortalSessionCookie(t *testing.T) {
	prev := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = prev })
	config.C.Server.BaseURL = "https://connect.example.com"

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"token":"sess_abc","id":"acct_1"}`))
	})
	h := AttachPortalSessionCookie(inner)
	req := httptest.NewRequest(http.MethodPost, "/portal/login", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Value != "sess_abc" {
		t.Fatalf("cookies=%v", cookies)
	}
	if !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || !cookies[0].Secure {
		t.Fatalf("flags httponly=%v samesite=%v secure=%v", cookies[0].HttpOnly, cookies[0].SameSite, cookies[0].Secure)
	}
}

func TestAttachPortalSessionCookieSkipsNonToken(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"requires_2fa":true}`))
	})
	h := AttachPortalSessionCookie(inner)
	req := httptest.NewRequest(http.MethodPost, "/portal/login", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if len(rec.Result().Cookies()) != 0 {
		t.Fatalf("unexpected cookie on 2FA challenge: %v", rec.Result().Cookies())
	}
}

func TestPortalLogout(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/portal/logout", nil)
	rec := httptest.NewRecorder()
	PortalLogout(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	c := rec.Result().Cookies()[0]
	if c.MaxAge != -1 {
		t.Fatalf("MaxAge=%d", c.MaxAge)
	}
}
