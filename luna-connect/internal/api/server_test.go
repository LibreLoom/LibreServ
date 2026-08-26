package api

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/setuphub"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

func testServer(t *testing.T) http.Handler {
	t.Helper()
	return testServerWithProviders(t, nil, nil)
}

func testServerWithProviders(t *testing.T, tunnel providers.Tunnel, dns providers.DNS) http.Handler {
	t.Helper()
	t.Setenv("LUNACONNECT_DEV", "1")
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	st, err := store.NewLocal(filepath.Join(dir, "obj"))
	if err != nil {
		t.Fatal(err)
	}
	config.C.Server.BaseURL = "https://connect.luna.libreloom.org"
	if tunnel == nil {
		tunnel = &providers.TunnelClient{MockMode: true}
	}
	if dns == nil {
		dns = &providers.DNSClient{MockMode: true}
	}
	s := &Server{
		db: db,
		deps: handlers.Deps{
			DB: db, Store: st, Tunnel: tunnel, DNS: dns, Hub: setuphub.New(),
		},
	}
	s.routes()
	return s.Router()
}

func TestSecurityHeaders(t *testing.T) {
	h := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("nosniff")
	}
	if rec.Header().Get("X-Frame-Options") != "DENY" {
		t.Fatal("frame")
	}
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("csp %s", csp)
	}
}

func TestCSRFRejectsCookiePOSTWithoutToken(t *testing.T) {
	h := testServer(t)
	get := httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
	grec := httptest.NewRecorder()
	h.ServeHTTP(grec, get)
	var csrf string
	for _, c := range grec.Result().Cookies() {
		if c.Name == "luna_connect_csrf" {
			csrf = c.Value
		}
	}
	if csrf == "" {
		t.Fatal("expected csrf cookie on GET")
	}
	bad := httptest.NewRequest(http.MethodPost, "/api/v1/account/register", strings.NewReader(`{"email":"a@b.co","password":"password1"}`))
	bad.AddCookie(&http.Cookie{Name: "luna_connect_csrf", Value: csrf})
	brec := httptest.NewRecorder()
	h.ServeHTTP(brec, bad)
	if brec.Code != http.StatusForbidden {
		t.Fatalf("missing csrf header %d %s", brec.Code, brec.Body.String())
	}
	ok := httptest.NewRequest(http.MethodPost, "/api/v1/account/register", strings.NewReader(`{"email":"a@b.co","password":"password1"}`))
	ok.AddCookie(&http.Cookie{Name: "luna_connect_csrf", Value: csrf})
	ok.Header.Set("X-CSRF-Token", csrf)
	orec := httptest.NewRecorder()
	h.ServeHTTP(orec, ok)
	if orec.Code != http.StatusCreated {
		t.Fatalf("csrf ok %d %s", orec.Code, orec.Body.String())
	}
}
