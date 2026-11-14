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
		{"could not save Tailscale startup information: permission denied", "Sol could not save Tailscale startup information. Check Sol's storage and try again."},
		{"a previous Tailscale start could not be verified: file exists", "A previous Tailscale start could not be verified."},
		{"connect Tailscale first", "Connect Tailscale first."},
		{"Tailscale is starting but not responding yet", "Sol's remote access is starting. Wait a moment and try again."},
		{"Tailscale's private listener stopped", "Sol can't offer remote access right now. Restart Sol and try again."},
		{"Tailscale is off. Restart Sol and try turning on private access again.", "Tailscale is off. Restart Sol and try turning on private access again."},
	} {
		w := httptest.NewRecorder()
		tailscaleFailure(w, "connect to Tailscale", errors.New(tc.input))
		if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), tc.want) {
			t.Fatalf("input %q: %d %s", tc.input, w.Code, w.Body.String())
		}
	}
}
