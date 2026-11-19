package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestTrustedProxyLoopbackAlwaysAllowed(t *testing.T) {
	prev := config.C.TrustedProxies
	t.Cleanup(func() { config.C.TrustedProxies = prev })
	config.C.TrustedProxies = ""

	if !trustedProxy("127.0.0.1") {
		t.Fatal("IPv4 loopback should be trusted")
	}
	if !trustedProxy("::1") {
		t.Fatal("IPv6 loopback should be trusted")
	}
}

func TestTrustedProxyConfiguredCIDR(t *testing.T) {
	prev := config.C.TrustedProxies
	t.Cleanup(func() { config.C.TrustedProxies = prev })
	config.C.TrustedProxies = "10.0.0.0/8, 192.168.1.5, 2001:db8::/32"

	for _, ip := range []string{"10.1.2.3", "192.168.1.5", "2001:db8::1"} {
		if !trustedProxy(ip) {
			t.Fatalf("%s should be trusted: it is in trusted_proxies", ip)
		}
	}
	if trustedProxy("192.168.1.6") {
		t.Fatal("an address outside the configured entries must not be trusted")
	}
}

func TestTrustedProxyUnlistedPrivateIP(t *testing.T) {
	prev := config.C.TrustedProxies
	t.Cleanup(func() { config.C.TrustedProxies = prev })
	config.C.TrustedProxies = ""

	// A private peer is not a proxy just because it is private: the Connect
	// port can be reachable from the whole LAN or container network.
	for _, ip := range []string{"10.0.0.5", "172.17.0.1", "192.168.1.10", "203.0.113.10"} {
		if trustedProxy(ip) {
			t.Fatalf("%s must not be trusted without a trusted_proxies entry", ip)
		}
	}
}

func TestTrustedProxyMalformedEntryFailsClosed(t *testing.T) {
	prev := config.C.TrustedProxies
	t.Cleanup(func() { config.C.TrustedProxies = prev })
	config.C.TrustedProxies = "not-an-address, 10.0.0.0/99"

	if trustedProxy("10.1.2.3") {
		t.Fatal("malformed entries must not trust anything")
	}
	if !trustedProxy("127.0.0.1") {
		t.Fatal("loopback must stay trusted even with a bad config")
	}
}

func TestClientIPIgnoresForwardedHeadersFromUntrustedPeer(t *testing.T) {
	prev := config.C.TrustedProxies
	t.Cleanup(func() { config.C.TrustedProxies = prev })
	config.C.TrustedProxies = ""

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.5:1234"
	req.Header.Set("CF-Connecting-IP", "198.51.100.7")
	req.Header.Set("X-Real-IP", "198.51.100.8")
	req.Header.Set("X-Forwarded-For", "198.51.100.9")

	if got := ClientIP(req); got != "10.0.0.5" {
		t.Fatalf("untrusted peer: got %q, want the peer address", got)
	}

	// The same request from a configured proxy uses the forwarded address.
	config.C.TrustedProxies = "10.0.0.0/8"
	if got := ClientIP(req); got != "198.51.100.7" {
		t.Fatalf("trusted proxy: got %q, want CF-Connecting-IP", got)
	}

	// Loopback is the shipped Caddy hop and needs no entry.
	req.RemoteAddr = "127.0.0.1:1234"
	config.C.TrustedProxies = ""
	if got := ClientIP(req); got != "198.51.100.7" {
		t.Fatalf("loopback proxy: got %q, want CF-Connecting-IP", got)
	}
}
