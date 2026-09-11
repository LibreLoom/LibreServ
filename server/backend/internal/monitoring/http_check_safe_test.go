package monitoring

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIsBlockedHTTPCheckIP(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"127.0.0.1", false}, // loopback allowed for local app checks
		{"::1", false},
		{"::ffff:127.0.0.1", false},
		{"::127.0.0.1", false}, // IPv4-compatible loopback still allowed
		{"10.0.0.1", true},
		{"192.168.1.1", true},
		{"172.16.5.5", true},
		{"169.254.169.254", true},
		{"100.64.1.1", true},
		{"0.0.0.0", true},
		{"::ffff:10.1.2.3", true},
		{"::10.0.0.1", true},
		{"::169.254.169.254", true},
		{"::100.64.1.1", true},
		{"2001:4860:4860::8888", false},
	}
	for _, tt := range cases {
		ip := net.ParseIP(tt.ip)
		if ip == nil {
			t.Fatalf("ParseIP(%q) failed", tt.ip)
		}
		if got := isBlockedHTTPCheckIP(ip); got != tt.want {
			t.Errorf("isBlockedHTTPCheckIP(%q) = %v, want %v", tt.ip, got, tt.want)
		}
	}
}

func TestValidateHTTPCheckURL_BlocksPrivateAndMetadata(t *testing.T) {
	blocked := []string{
		"http://10.0.0.5/health",
		"http://192.168.1.1/health",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::ffff:10.1.2.3]/health",
		"http://[::10.0.0.1]/health",
		"http://[::169.254.169.254]/health",
		"http://metadata.google.internal/",
		"ftp://127.0.0.1/health",
		"",
	}
	for _, raw := range blocked {
		if err := validateHTTPCheckURL(raw); err == nil {
			t.Errorf("validateHTTPCheckURL(%q) = nil, want error", raw)
		}
	}

	allowed := []string{
		"http://127.0.0.1/health",
		"http://localhost/health",
		"http://[::1]/health",
		"http://8.8.8.8/health",
	}
	for _, raw := range allowed {
		if err := validateHTTPCheckURL(raw); err != nil {
			t.Errorf("validateHTTPCheckURL(%q) unexpected error: %v", raw, err)
		}
	}
}

func TestHTTPCheck_Run_BlocksPrivateURL(t *testing.T) {
	check := NewHTTPCheck(HTTPCheckConfig{URL: "http://10.0.0.1/"}, time.Second)
	res := check.Run(context.Background())
	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", res.Status)
	}
	if !strings.Contains(res.Message, "Blocked health check URL") {
		t.Errorf("message = %q, want blocked-URL wording", res.Message)
	}
}

func TestHTTPCheck_Run_BlocksMetadataURL(t *testing.T) {
	check := NewHTTPCheck(HTTPCheckConfig{URL: "http://169.254.169.254/"}, time.Second)
	res := check.Run(context.Background())
	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", res.Status)
	}
	if !strings.Contains(strings.ToLower(res.Message), "blocked") {
		t.Errorf("message = %q, want blocked wording", res.Message)
	}
}

func TestHTTPCheck_Client_RefusesRedirects(t *testing.T) {
	finalHit := false
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		finalHit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer final.Close()

	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL, http.StatusFound)
	}))
	defer redir.Close()

	check := NewHTTPCheck(HTTPCheckConfig{URL: redir.URL, ExpectedStatus: http.StatusOK}, time.Second)
	res := check.Run(context.Background())
	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy when redirect refused (%s)", res.Status, res.Message)
	}
	if finalHit {
		t.Fatal("redirect target must not be fetched")
	}
}
