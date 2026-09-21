package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestCSRFRejectsEvilOrigin(t *testing.T) {
	h := testServer(t)
	prev := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = prev })
	config.C.Server.BaseURL = "https://connect.luna.libreloom.org"

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

	evil := httptest.NewRequest(http.MethodPost, "/api/v1/account/register", strings.NewReader(`{"email":"evil@b.co","password":"password1234"}`))
	evil.AddCookie(&http.Cookie{Name: "luna_connect_csrf", Value: csrf})
	evil.Header.Set("X-CSRF-Token", csrf)
	evil.Header.Set("Origin", "https://evil.example")
	erec := httptest.NewRecorder()
	h.ServeHTTP(erec, evil)
	if erec.Code != http.StatusForbidden {
		t.Fatalf("evil origin %d %s", erec.Code, erec.Body.String())
	}

	ok := httptest.NewRequest(http.MethodPost, "/api/v1/account/register", strings.NewReader(`{"email":"okorigin@b.co","password":"password1234"}`))
	ok.AddCookie(&http.Cookie{Name: "luna_connect_csrf", Value: csrf})
	ok.Header.Set("X-CSRF-Token", csrf)
	ok.Header.Set("Origin", "https://connect.luna.libreloom.org")
	okRec := httptest.NewRecorder()
	h.ServeHTTP(okRec, ok)
	if okRec.Code != http.StatusCreated {
		t.Fatalf("matching origin %d %s", okRec.Code, okRec.Body.String())
	}
}
