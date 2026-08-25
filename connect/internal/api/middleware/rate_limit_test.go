package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFailLimiterBlocksAfterBudget(t *testing.T) {
	l := newFailLimiter(3, time.Minute)
	ip := "203.0.113.9"
	if l.blocked(ip) {
		t.Fatal("fresh limiter should not be blocked")
	}
	for i := 0; i < 3; i++ {
		l.fail(ip)
	}
	if !l.blocked(ip) {
		t.Fatal("expected block after the failure budget")
	}
	other := "203.0.113.10"
	if l.blocked(other) {
		t.Fatal("a different address should keep its own budget")
	}
}

func TestClientIPIgnoresForwardedForFromPublicPeer(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "198.51.100.4:443"
	req.Header.Set("X-Forwarded-For", "192.0.2.1")
	if got := ClientIP(req); got != "198.51.100.4" {
		t.Fatalf("ClientIP=%q, want public peer (not the spoofed header)", got)
	}
}
