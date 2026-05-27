package main

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// tokenBucket implements a per-key token bucket rate limiter.
// Thread-safe; keys expire after inactivity and are cleaned up periodically.
type tokenBucket struct {
	tokens     float64
	lastRefill time.Time
}

type rateLimiter struct {
	mu             sync.Mutex
	buckets        map[string]*tokenBucket
	rate           float64       // tokens per second
	burst          int           // max accumulated tokens
	cleanupAge     time.Duration // remove buckets idle this long
}

func newRateLimiter(rate float64, burst int) *rateLimiter {
	rl := &rateLimiter{
		buckets:    make(map[string]*tokenBucket),
		rate:       rate,
		burst:      burst,
		cleanupAge: 10 * time.Minute,
	}
	go rl.cleanupLoop()
	return rl
}

// Allow returns true if the key has a token available, consuming one.
func (rl *rateLimiter) Allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[key]
	if !ok {
		b = &tokenBucket{tokens: float64(rl.burst), lastRefill: time.Now()}
		rl.buckets[key] = b
	}

	// Refill based on elapsed time
	now := time.Now()
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens += elapsed * rl.rate
	if b.tokens > float64(rl.burst) {
		b.tokens = float64(rl.burst)
	}
	b.lastRefill = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (rl *rateLimiter) cleanupLoop() {
	ticker := time.NewTicker(rl.cleanupAge)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		cutoff := time.Now().Add(-rl.cleanupAge)
		for key, b := range rl.buckets {
			if b.lastRefill.Before(cutoff) {
				delete(rl.buckets, key)
			}
		}
		rl.mu.Unlock()
	}
}

// rateLimitMiddleware returns an HTTP middleware that rate-limits by client IP.
// Skips rate limiting entirely when rate is 0 (unlimited).
func rateLimitMiddleware(rl *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if rl == nil {
				next.ServeHTTP(w, r)
				return
			}
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				host = r.RemoteAddr
			}
		if !rl.Allow(host) {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusTooManyRequests, map[string]interface{}{
				"error": map[string]string{
					"message": "Too many requests. Please slow down and try again.",
					"type":    "rate_limit_exceeded",
				},
			})
			return
		}
			next.ServeHTTP(w, r)
		})
	}
}

// rateLimitDeviceMiddleware rate-limits by device ID (from X-Device-ID header).
// Falls back to IP if no device ID is present.
func rateLimitDeviceMiddleware(rl *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if rl == nil {
				next.ServeHTTP(w, r)
				return
			}
			key := r.Header.Get("X-Device-ID")
			if key == "" {
				host, _, err := net.SplitHostPort(r.RemoteAddr)
				if err != nil {
					host = r.RemoteAddr
				}
				key = host
			}
			if !rl.Allow(key) {
				w.Header().Set("Retry-After", "1")
				writeJSON(w, http.StatusTooManyRequests, map[string]interface{}{
					"error": map[string]string{
						"message": "Too many requests. Please slow down and try again.",
						"type":    "rate_limit_exceeded",
					},
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
