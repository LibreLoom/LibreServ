package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimitBlocksAfterLimit(t *testing.T) {
	rules := []RateRule{{Prefix: "/api/test", Limit: 2, Window: time.Minute}}
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
