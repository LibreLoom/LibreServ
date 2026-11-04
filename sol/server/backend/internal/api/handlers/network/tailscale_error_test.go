package network

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTailscaleFailureUsesAccurateGuidance(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"Sol is shutting down", "Sol is shutting down."},
		{"Tailscale is starting. Try connecting again shortly", "Tailscale is starting. Try connecting again shortly."},
		{"internal socket failure", "Sol could not connect to Tailscale. Try again."},
	} {
		w := httptest.NewRecorder()
		tailscaleFailure(w, "connect to Tailscale", errors.New(tc.input))
		if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), tc.want) {
			t.Fatalf("input %q: %d %s", tc.input, w.Code, w.Body.String())
		}
	}
}
