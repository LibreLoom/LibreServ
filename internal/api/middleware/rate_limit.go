package middleware

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RateRule defines a simple window-based rate limit.
type RateRule struct {
	Prefix string
	Limit  int
	Window time.Duration
}

type bucket struct {
	count       int
	windowStart time.Time
}

type limiter struct {
	rules []RateRule
	mu    sync.Mutex
	data  map[string]*bucket
}

// RateLimitDefault applies conservative limits on setup/auth endpoints.
func RateLimitDefault() func(http.Handler) http.Handler {
	rules := []RateRule{
		{Prefix: "/api/v1/setup", Limit: 10, Window: time.Minute},
		{Prefix: "/api/v1/auth", Limit: 30, Window: time.Minute},
	}
	return RateLimit(rules)
}

// RateLimit applies simple fixed-window limits.
func RateLimit(rules []RateRule) func(http.Handler) http.Handler {
	l := &limiter{
		rules: rules,
		data:  make(map[string]*bucket),
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rule, ok := l.matchRule(r.URL.Path)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}

			key := l.keyFor(r, rule)
			remaining, reset, allowed := l.take(key, rule)

			w.Header().Set("X-RateLimit-Limit", intToStr(rule.Limit))
			w.Header().Set("X-RateLimit-Remaining", intToStr(remaining))
			w.Header().Set("X-RateLimit-Reset", intToStr(int(reset.Seconds())))

			if !allowed {
				http.Error(w, `{"error": "rate limit exceeded"}`, http.StatusTooManyRequests)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func (l *limiter) matchRule(path string) (RateRule, bool) {
	for _, r := range l.rules {
		if strings.HasPrefix(path, r.Prefix) {
			return r, true
		}
	}
	return RateRule{}, false
}

func (l *limiter) keyFor(r *http.Request, rule RateRule) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return rule.Prefix + "::" + host
}

func (l *limiter) take(key string, rule RateRule) (remaining int, reset time.Duration, allowed bool) {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.data[key]
	if !ok || now.Sub(b.windowStart) >= rule.Window {
		b = &bucket{count: 0, windowStart: now}
		l.data[key] = b
	}

	if b.count >= rule.Limit {
		return 0, rule.Window - now.Sub(b.windowStart), false
	}

	b.count++
	return rule.Limit - b.count, rule.Window - now.Sub(b.windowStart), true
}

func intToStr(v int) string {
	return strconv.Itoa(v)
}
