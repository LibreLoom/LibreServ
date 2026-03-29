package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimitBlocksAfterLimit(t *testing.T) {
	rules := []RateRule{{Prefix: "/api/test", Limit: 2, Window: time.Minute, ByUser: false}}
	rl := RateLimit(rules)
	count := 0
	handler := rl(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count++
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/test/resource", nil)
	rr1 := httptest.NewRecorder()
	handler.ServeHTTP(rr1, req)
	if rr1.Code != http.StatusOK {
		t.Fatalf("first request unexpected status: %d", rr1.Code)
	}
	rr2 := httptest.NewRecorder()
	handler.ServeHTTP(rr2, req)
	if rr2.Code != http.StatusOK {
		t.Fatalf("second request unexpected status: %d", rr2.Code)
	}
	rr3 := httptest.NewRecorder()
	handler.ServeHTTP(rr3, req)
	if rr3.Code != http.StatusTooManyRequests {
		t.Fatalf("expected rate limit, got %d", rr3.Code)
	}
	if count != 2 {
		t.Fatalf("handler should run twice, ran %d", count)
	}
}

func TestRateLimitByUser(t *testing.T) {
	rules := []RateRule{{Prefix: "/api/test", Limit: 2, Window: time.Minute, ByUser: true}}
	rl := RateLimit(rules)
	count := 0
	handler := rl(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count++
		w.WriteHeader(http.StatusOK)
	}))

	req1 := httptest.NewRequest(http.MethodGet, "/api/test/resource", nil)
	ctx1 := context.WithValue(req1.Context(), UserIDContextKey, "user1")
	req1 = req1.WithContext(ctx1)
	rr1 := httptest.NewRecorder()
	handler.ServeHTTP(rr1, req1)
	if rr1.Code != http.StatusOK {
		t.Fatalf("user1 first request unexpected status: %d", rr1.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/api/test/resource", nil)
	ctx2 := context.WithValue(req2.Context(), UserIDContextKey, "user2")
	req2 = req2.WithContext(ctx2)
	rr2 := httptest.NewRecorder()
	handler.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Fatalf("user2 first request unexpected status: %d", rr2.Code)
	}

	req3 := httptest.NewRequest(http.MethodGet, "/api/test/resource", nil)
	ctx3 := context.WithValue(req3.Context(), UserIDContextKey, "user1")
	req3 = req3.WithContext(ctx3)
	rr3 := httptest.NewRecorder()
	handler.ServeHTTP(rr3, req3)
	if rr3.Code != http.StatusOK {
		t.Fatalf("user1 second request unexpected status: %d", rr3.Code)
	}

	req4 := httptest.NewRequest(http.MethodGet, "/api/test/resource", nil)
	ctx4 := context.WithValue(req4.Context(), UserIDContextKey, "user1")
	req4 = req4.WithContext(ctx4)
	rr4 := httptest.NewRecorder()
	handler.ServeHTTP(rr4, req4)
	if rr4.Code != http.StatusTooManyRequests {
		t.Fatalf("expected rate limit for user1, got %d", rr4.Code)
	}

	if count != 3 {
		t.Fatalf("handler should run 3 times, ran %d", count)
	}
}

func TestRateLimitReturns429WithRetryAfter(t *testing.T) {
	rules := []RateRule{{Prefix: "/api/test", Limit: 1, Window: time.Minute, ByUser: false}}
	rl := RateLimit(rules)
	handler := rl(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/test/resource", nil)
	rr1 := httptest.NewRecorder()
	handler.ServeHTTP(rr1, req)
	if rr1.Code != http.StatusOK {
		t.Fatalf("first request unexpected status: %d", rr1.Code)
	}

	rr2 := httptest.NewRecorder()
	handler.ServeHTTP(rr2, req)
	if rr2.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", rr2.Code)
	}

	retryAfter := rr2.Header().Get("Retry-After")
	if retryAfter == "" {
		t.Fatal("expected Retry-After header to be set")
	}

	limitHeader := rr2.Header().Get("X-RateLimit-Limit")
	if limitHeader != "1" {
		t.Fatalf("expected X-RateLimit-Limit to be 1, got %s", limitHeader)
	}
}

func TestRateLimitFallbackToIPWhenNoUser(t *testing.T) {
	rules := []RateRule{{Prefix: "/api/test", Limit: 1, Window: time.Minute, ByUser: true}}
	rl := RateLimit(rules)
	count := 0
	handler := rl(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count++
		w.WriteHeader(http.StatusOK)
	}))

	req1 := httptest.NewRequest(http.MethodGet, "/api/test/resource", nil)
	req1.RemoteAddr = "192.168.1.1:1234"
	rr1 := httptest.NewRecorder()
	handler.ServeHTTP(rr1, req1)
	if rr1.Code != http.StatusOK {
		t.Fatalf("first request unexpected status: %d", rr1.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/api/test/resource", nil)
	req2.RemoteAddr = "192.168.1.1:1234"
	rr2 := httptest.NewRecorder()
	handler.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusTooManyRequests {
		t.Fatalf("expected rate limit for same IP, got %d", rr2.Code)
	}

	req3 := httptest.NewRequest(http.MethodGet, "/api/test/resource", nil)
	req3.RemoteAddr = "192.168.1.2:1234"
	rr3 := httptest.NewRecorder()
	handler.ServeHTTP(rr3, req3)
	if rr3.Code != http.StatusOK {
		t.Fatalf("different IP should not be rate limited, got %d", rr3.Code)
	}

	if count != 2 {
		t.Fatalf("handler should run 2 times, ran %d", count)
	}
}

func TestRateLimitDefaultUsesSpecificSetupRules(t *testing.T) {
	rl := RateLimitDefault()
	count := 0
	handler := rl(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count++
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/setup/complete", nil)
	for i := 0; i < 15; i++ {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d unexpected status: %d", i+1, rr.Code)
		}
	}

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("expected rate limit, got %d", rr.Code)
	}
	if count != 15 {
		t.Fatalf("handler should run 15 times, ran %d", count)
	}
}
