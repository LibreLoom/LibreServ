package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/auth"
)

// TestMain points HIBP at a local empty stub so register/password tests stay
// hermetic (no real breach matches, no outbound network).
func TestMain(m *testing.M) {
	hibpStub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(""))
	}))
	defer hibpStub.Close()
	auth.SetHIBPRangeURL(hibpStub.URL + "/range/")
	os.Exit(m.Run())
}
