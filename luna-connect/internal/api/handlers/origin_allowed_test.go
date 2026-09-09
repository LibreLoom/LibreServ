package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestOriginAllowedFallsBackToRequestHost(t *testing.T) {
	prev := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = prev })
	config.C.Server.BaseURL = ""

	hostOK := httptest.NewRequest(http.MethodGet, "https://connect.luna.libreloom.org/", nil)
	hostOK.Host = "connect.luna.libreloom.org"
	hostOK.Header.Set("Origin", "https://connect.luna.libreloom.org")
	if !originAllowed(hostOK) {
		t.Fatal("empty baseURL should allow matching request host")
	}

	hostBad := httptest.NewRequest(http.MethodGet, "https://connect.luna.libreloom.org/", nil)
	hostBad.Host = "connect.luna.libreloom.org"
	hostBad.Header.Set("Origin", "https://evil.example")
	if originAllowed(hostBad) {
		t.Fatal("empty baseURL must reject mismatched origin host")
	}
}
