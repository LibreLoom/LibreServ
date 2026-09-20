package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
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
	config.C.Server.AtRestKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if tunnel == nil {
		tunnel = &providers.TunnelClient{MockMode: true}
	}
	if dns == nil {
		dns = &providers.DNSClient{MockMode: true}
	}
	s := &Server{
		db: db,
		deps: handlers.Deps{
			DB: db, Store: st, Tunnel: tunnel, DNS: dns,
		},
	}
	s.routes()
	return s.Router()
}

func TestAdminProvidersBrowserRefreshServesSPA(t *testing.T) {
	webDir := filepath.Join(t.TempDir(), "web")
	if err := os.MkdirAll(webDir, 0o755); err != nil {
		t.Fatal(err)
	}
	index := "<!doctype html><html><body>Luna Connect</body></html>"
	if err := os.WriteFile(filepath.Join(webDir, "index.html"), []byte(index), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LUNACONNECT_DEV", "1")
	config.C.Server.WebDir = webDir

	h := testServer(t)

	nav := httptest.NewRequest(http.MethodGet, "/admin/providers", nil)
	nav.Header.Set("Accept", "text/html,application/xhtml+xml")
	navRec := httptest.NewRecorder()
	h.ServeHTTP(navRec, nav)
	if navRec.Code != http.StatusOK {
		t.Fatalf("browser refresh want 200, got %d body=%q", navRec.Code, navRec.Body.String())
	}
	if !strings.Contains(navRec.Body.String(), "Luna Connect") {
		t.Fatalf("expected SPA index, got %q", navRec.Body.String())
	}
	if !strings.Contains(navRec.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("content-type %q", navRec.Header().Get("Content-Type"))
	}

	api := httptest.NewRequest(http.MethodGet, "/admin/providers", nil)
	api.Header.Set("Accept", "application/json")
	apiRec := httptest.NewRecorder()
	h.ServeHTTP(apiRec, api)
	if apiRec.Code != http.StatusUnauthorized {
		t.Fatalf("API call want 401, got %d body=%q", apiRec.Code, apiRec.Body.String())
	}
	if !strings.Contains(apiRec.Body.String(), "Admin sign-in required") {
		t.Fatalf("API body %q", apiRec.Body.String())
	}
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
	if !strings.Contains(csp, "https://static.cloudflareinsights.com") {
		t.Fatalf("csp missing cloudflare insights: %s", csp)
	}
	if !strings.Contains(csp, "script-src 'self' https://js.stripe.com https://static.cloudflareinsights.com") {
		t.Fatalf("csp script-src: %s", csp)
	}
}

func TestHealthzSoftDrain(t *testing.T) {
	h := testServer(t)

	okReq := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	okRec := httptest.NewRecorder()
	h.ServeHTTP(okRec, okReq)
	if okRec.Code != http.StatusOK {
		t.Fatalf("want 200 without drain file, got %d", okRec.Code)
	}

	drain := filepath.Join(t.TempDir(), "drain-a")
	if err := os.WriteFile(drain, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LUNACONNECT_DRAIN_FILE", drain)

	drainReq := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	drainRec := httptest.NewRecorder()
	h.ServeHTTP(drainRec, drainReq)
	if drainRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 while draining, got %d body=%q", drainRec.Code, drainRec.Body.String())
	}
	if !strings.Contains(drainRec.Body.String(), "draining") {
		t.Fatalf("body %q", drainRec.Body.String())
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
	bad := httptest.NewRequest(http.MethodPost, "/api/v1/account/register", strings.NewReader(`{"email":"a@b.co","password":"password1234"}`))
	bad.AddCookie(&http.Cookie{Name: "luna_connect_csrf", Value: csrf})
	brec := httptest.NewRecorder()
	h.ServeHTTP(brec, bad)
	if brec.Code != http.StatusForbidden {
		t.Fatalf("missing csrf header %d %s", brec.Code, brec.Body.String())
	}
	ok := httptest.NewRequest(http.MethodPost, "/api/v1/account/register", strings.NewReader(`{"email":"a@b.co","password":"password1234"}`))
	ok.AddCookie(&http.Cookie{Name: "luna_connect_csrf", Value: csrf})
	ok.Header.Set("X-CSRF-Token", csrf)
	orec := httptest.NewRecorder()
	h.ServeHTTP(orec, ok)
	if orec.Code != http.StatusCreated {
		t.Fatalf("csrf ok %d %s", orec.Code, orec.Body.String())
	}
}

func TestSessionAndCSRFCookiesUseSevenDayMaxAge(t *testing.T) {
	h := testServer(t)
	get := httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
	grec := httptest.NewRecorder()
	h.ServeHTTP(grec, get)
	var csrf string
	var csrfMax int
	for _, c := range grec.Result().Cookies() {
		if c.Name == "luna_connect_csrf" {
			csrf = c.Value
			csrfMax = c.MaxAge
		}
	}
	if csrf == "" {
		t.Fatal("expected csrf cookie on GET")
	}
	want := int(handlers.SessionTTL.Seconds())
	if csrfMax != want {
		t.Fatalf("csrf MaxAge %d want %d", csrfMax, want)
	}
	ok := httptest.NewRequest(http.MethodPost, "/api/v1/account/register", strings.NewReader(`{"email":"ttl@b.co","password":"password1234"}`))
	ok.AddCookie(&http.Cookie{Name: "luna_connect_csrf", Value: csrf})
	ok.Header.Set("X-CSRF-Token", csrf)
	orec := httptest.NewRecorder()
	h.ServeHTTP(orec, ok)
	if orec.Code != http.StatusCreated {
		t.Fatalf("register %d %s", orec.Code, orec.Body.String())
	}
	var sessionMax int
	for _, c := range orec.Result().Cookies() {
		if c.Name == "luna_connect_session" {
			sessionMax = c.MaxAge
		}
	}
	if sessionMax != want {
		t.Fatalf("session MaxAge %d want %d", sessionMax, want)
	}
}
