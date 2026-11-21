package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

const testOrigin = "https://connect.luna.libreloom.org"

func csrfCookie(t *testing.T, h http.Handler) string {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/config", nil))
	for _, c := range rec.Result().Cookies() {
		if c.Name == "luna_connect_csrf" {
			return c.Value
		}
	}
	t.Fatal("expected csrf cookie on GET")
	return ""
}

// adminReq builds a request; csrf "" leaves the CSRF cookie and header off, origin "" leaves Origin off.
func adminReq(method, path, body, csrf, origin string, cookies ...*http.Cookie) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Accept", "application/json")
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if csrf != "" {
		r.AddCookie(&http.Cookie{Name: "luna_connect_csrf", Value: csrf})
		r.Header.Set("X-CSRF-Token", csrf)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	for _, c := range cookies {
		r.AddCookie(c)
	}
	return r
}

func serve(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func adminCookieFrom(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == handlers.AdminSessionCookie {
			return c
		}
	}
	return nil
}

// seedAndLoginAdmin creates the first staff account and signs it in, returning the session cookie.
func seedAndLoginAdmin(t *testing.T, h http.Handler, csrf string) *http.Cookie {
	t.Helper()
	seed := adminReq(http.MethodPost, "/admin/seed", `{"email":"staff@example.com","password":"password1234","name":"Staff"}`, csrf, testOrigin)
	seed.RemoteAddr = "127.0.0.1:4000"
	if rec := serve(h, seed); rec.Code != http.StatusOK {
		t.Fatalf("seed %d %s", rec.Code, rec.Body.String())
	}
	rec := serve(h, adminReq(http.MethodPost, "/admin/login", `{"email":"staff@example.com","password":"password1234"}`, csrf, testOrigin))
	if rec.Code != http.StatusOK {
		t.Fatalf("login %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"token"`) {
		t.Fatalf("login body must not carry the session token: %s", rec.Body.String())
	}
	c := adminCookieFrom(rec)
	if c == nil || c.Value == "" {
		t.Fatal("login must set the admin session cookie")
	}
	if !c.HttpOnly || c.Path != "/admin" || c.SameSite != http.SameSiteStrictMode || c.MaxAge <= 0 {
		t.Fatalf("admin cookie flags: %+v", c)
	}
	if c.Name == "luna_connect_session" {
		t.Fatal("admin cookie must not share the customer cookie name")
	}
	return &http.Cookie{Name: c.Name, Value: c.Value}
}

func resetAdminConfig(t *testing.T) {
	prevToken, prevSeed, prevTTL := config.C.Server.AdminToken, config.C.Auth.AdminSeedToken, config.C.Auth.SessionTTLHours
	t.Cleanup(func() {
		config.C.Server.AdminToken, config.C.Auth.AdminSeedToken, config.C.Auth.SessionTTLHours = prevToken, prevSeed, prevTTL
	})
	config.C.Server.AdminToken = ""
	config.C.Auth.AdminSeedToken = ""
	config.C.Auth.SessionTTLHours = 24
}

func TestAdminCookieSessionFlow(t *testing.T) {
	resetAdminConfig(t)
	h := testServer(t)
	csrf := csrfCookie(t, h)
	session := seedAndLoginAdmin(t, h, csrf)

	if rec := serve(h, adminReq(http.MethodGet, "/admin/me", "", "", "", session)); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "staff@example.com") {
		t.Fatalf("me with cookie %d %s", rec.Code, rec.Body.String())
	}

	// The session token is a cookie credential only: as a Bearer it is refused.
	bearer := adminReq(http.MethodGet, "/admin/me", "", "", "")
	bearer.Header.Set("Authorization", "Bearer "+session.Value)
	if rec := serve(h, bearer); rec.Code != http.StatusUnauthorized {
		t.Fatalf("session token as Bearer %d %s", rec.Code, rec.Body.String())
	}

	// The customer cookie name does not open admin routes, even with a staff token in it.
	customer := &http.Cookie{Name: "luna_connect_session", Value: session.Value}
	if rec := serve(h, adminReq(http.MethodGet, "/admin/me", "", "", "", customer)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("customer cookie on admin route %d %s", rec.Code, rec.Body.String())
	}

	// Mutations need the CSRF token and a matching Origin.
	if rec := serve(h, adminReq(http.MethodPost, "/admin/2fa/setup", `{}`, "", testOrigin, session)); rec.Code != http.StatusForbidden {
		t.Fatalf("mutation without csrf %d %s", rec.Code, rec.Body.String())
	}
	if rec := serve(h, adminReq(http.MethodPost, "/admin/2fa/setup", `{}`, csrf, "https://evil.example", session)); rec.Code != http.StatusForbidden {
		t.Fatalf("mutation from another origin %d %s", rec.Code, rec.Body.String())
	}
	if rec := serve(h, adminReq(http.MethodPost, "/admin/2fa/setup", `{}`, csrf, testOrigin, session)); rec.Code != http.StatusOK {
		t.Fatalf("mutation with csrf %d %s", rec.Code, rec.Body.String())
	}

	// Sign-out clears the cookie and ends the server session.
	out := serve(h, adminReq(http.MethodPost, "/admin/logout", `{}`, csrf, testOrigin, session))
	if out.Code != http.StatusOK {
		t.Fatalf("logout %d %s", out.Code, out.Body.String())
	}
	cleared := adminCookieFrom(out)
	if cleared == nil || cleared.MaxAge >= 0 || cleared.Path != "/admin" {
		t.Fatalf("logout must expire the admin cookie on /admin, got %+v", cleared)
	}
	if rec := serve(h, adminReq(http.MethodGet, "/admin/me", "", "", "", session)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("old cookie after logout %d %s", rec.Code, rec.Body.String())
	}
}

func TestAdminLogoutClearsCookieWithoutSession(t *testing.T) {
	resetAdminConfig(t)
	h := testServer(t)
	csrf := csrfCookie(t, h)
	stale := &http.Cookie{Name: handlers.AdminSessionCookie, Value: "not-a-session"}
	rec := serve(h, adminReq(http.MethodPost, "/admin/logout", `{}`, csrf, testOrigin, stale))
	if rec.Code != http.StatusOK {
		t.Fatalf("logout with stale cookie %d %s", rec.Code, rec.Body.String())
	}
	if c := adminCookieFrom(rec); c == nil || c.MaxAge >= 0 {
		t.Fatalf("stale cookie must be cleared, got %+v", c)
	}
}

func TestAdminProbeWithoutCookieIsNotThrottled(t *testing.T) {
	resetAdminConfig(t)
	h := testServer(t)
	// Every admin page load asks /admin/me; a signed-out browser must keep getting 401, not 429.
	for i := 0; i < 15; i++ {
		if rec := serve(h, adminReq(http.MethodGet, "/admin/me", "", "", "")); rec.Code != http.StatusUnauthorized {
			t.Fatalf("probe %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
}

func TestAdminWrongCookieIsThrottled(t *testing.T) {
	resetAdminConfig(t)
	h := testServer(t)
	bad := &http.Cookie{Name: handlers.AdminSessionCookie, Value: "guess"}
	var last int
	for i := 0; i < 12; i++ {
		last = serve(h, adminReq(http.MethodGet, "/admin/me", "", "", "", bad)).Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("repeated wrong cookies should be throttled, last status %d", last)
	}
}

func TestAdminStaticTokenIsBearerOnly(t *testing.T) {
	resetAdminConfig(t)
	config.C.Server.AdminToken = "ops-static-token"
	h := testServer(t)

	ok := adminReq(http.MethodGet, "/admin/stats", "", "", "")
	ok.Header.Set("Authorization", "Bearer ops-static-token")
	if rec := serve(h, ok); rec.Code != http.StatusOK {
		t.Fatalf("static token %d %s", rec.Code, rec.Body.String())
	}
	asCookie := &http.Cookie{Name: handlers.AdminSessionCookie, Value: "ops-static-token"}
	if rec := serve(h, adminReq(http.MethodGet, "/admin/stats", "", "", "", asCookie)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("static token as cookie %d %s", rec.Code, rec.Body.String())
	}
	wrong := adminReq(http.MethodGet, "/admin/stats", "", "", "")
	wrong.Header.Set("Authorization", "Bearer nope")
	if rec := serve(h, wrong); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong static token %d %s", rec.Code, rec.Body.String())
	}
}
