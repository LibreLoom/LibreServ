package network

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestResolveHostname(t *testing.T) {
	res, err := ResolveHostname(context.Background(), "localhost", 2*time.Second)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Hostname != "localhost" {
		t.Fatalf("hostname mismatch")
	}
}

func TestIsUsablePublicIP(t *testing.T) {
	tests := []struct {
		name string
		ip   string
		want bool
	}{
		{"public v4", "8.8.8.8", true},
		{"public v6", "2001:4860:4860::8888", true},
		{"loopback v4", "127.0.0.1", false},
		{"loopback v6", "::1", false},
		{"private 10", "10.0.0.1", false},
		{"private 192.168", "192.168.1.1", false},
		{"unspecified v4", "0.0.0.0", false},
		{"unspecified v6", "::", false},
		{"link-local v4", "169.254.1.1", false},
		{"link-local v6", "fe80::1", false},
		{"multicast v4", "224.0.0.1", false},
		{"multicast admin", "239.1.1.1", false},
		{"cgnat", "100.64.0.1", false},
		{"mapped private", "::ffff:10.1.2.3", false},
		{"mapped public", "::ffff:1.1.1.1", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			addr, err := netip.ParseAddr(tt.ip)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got := isUsablePublicIP(addr); got != tt.want {
				t.Fatalf("isUsablePublicIP(%s) = %v, want %v", tt.ip, got, tt.want)
			}
		})
	}
}

func withPublicIPTestClient(t *testing.T, urls []string) {
	t.Helper()
	prevClient := publicIPClient
	prevURLs := publicIPLookupURLs
	t.Cleanup(func() {
		publicIPClient = prevClient
		publicIPLookupURLs = prevURLs
	})
	publicIPClient = &http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errPublicIPRedirect
		},
	}
	publicIPLookupURLs = urls
}

func TestDetectPublicIP_AcceptsPublicResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("203.0.113.10\n"))
	}))
	t.Cleanup(srv.Close)
	withPublicIPTestClient(t, []string{srv.URL})

	ip, err := DetectPublicIP(context.Background())
	if err != nil {
		t.Fatalf("DetectPublicIP: %v", err)
	}
	want := netip.MustParseAddr("203.0.113.10")
	if ip != want {
		t.Fatalf("got %v, want %v", ip, want)
	}
}

func TestDetectPublicIP_RejectsPrivateAndFallsThrough(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("10.0.0.1"))
	}))
	t.Cleanup(bad.Close)
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("198.51.100.7"))
	}))
	t.Cleanup(good.Close)
	withPublicIPTestClient(t, []string{bad.URL, good.URL})

	ip, err := DetectPublicIP(context.Background())
	if err != nil {
		t.Fatalf("DetectPublicIP: %v", err)
	}
	want := netip.MustParseAddr("198.51.100.7")
	if ip != want {
		t.Fatalf("got %v, want %v", ip, want)
	}
}

func TestDetectPublicIP_AllNonPublicFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("127.0.0.1"))
	}))
	t.Cleanup(srv.Close)
	withPublicIPTestClient(t, []string{srv.URL})

	if _, err := DetectPublicIP(context.Background()); err == nil {
		t.Fatal("expected error when only loopback is returned")
	}
}

func TestDetectPublicIP_RefusesRedirects(t *testing.T) {
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("8.8.8.8"))
	}))
	t.Cleanup(final.Close)
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL, http.StatusFound)
	}))
	t.Cleanup(redir.Close)
	withPublicIPTestClient(t, []string{redir.URL})

	if _, err := DetectPublicIP(context.Background()); err == nil {
		t.Fatal("expected redirecting echo service to be skipped")
	}
}

func TestDetectPublicIP_RedirectErrorIsSentinel(t *testing.T) {
	// Ensure the production client wiring refuses redirects the same way.
	req, err := http.NewRequest(http.MethodGet, "http://example.invalid/", nil)
	if err != nil {
		t.Fatal(err)
	}
	err = publicIPClient.CheckRedirect(req, []*http.Request{req})
	if !errors.Is(err, errPublicIPRedirect) {
		t.Fatalf("CheckRedirect = %v, want %v", err, errPublicIPRedirect)
	}
}
