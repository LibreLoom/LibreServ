package middleware

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RateRule limits requests whose path starts with Prefix to Limit requests per
// Window, keyed on the caller's IP address.
type RateRule struct {
	Prefix string
	Limit  int
	Window time.Duration
}

type rateBucket struct {
	count       int
	windowStart time.Time
}

type rateLimiter struct {
	rules []RateRule
	mu    sync.Mutex
	data  map[string]*rateBucket
}

// RateLimit rejects callers that exceed any matching rule with 429. Rules are
// evaluated in order, so list more specific prefixes first.
func RateLimit(rules []RateRule) func(http.Handler) http.Handler {
	l := &rateLimiter{rules: rules, data: make(map[string]*rateBucket)}
	go l.cleanup()

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rule, ok := l.match(r.URL.Path)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			if !l.allow(rule, ClientIP(r)) {
				w.Header().Set("Retry-After", "60")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"error":"too many requests, please slow down"}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (l *rateLimiter) match(path string) (RateRule, bool) {
	for _, rule := range l.rules {
		if strings.HasPrefix(path, rule.Prefix) {
			return rule, true
		}
	}
	return RateRule{}, false
}

func (l *rateLimiter) allow(rule RateRule, ip string) bool {
	now := time.Now()
	key := rule.Prefix + "|" + ip

	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.data[key]
	if !ok || now.Sub(b.windowStart) >= rule.Window {
		l.data[key] = &rateBucket{count: 1, windowStart: now}
		return true
	}
	if b.count >= rule.Limit {
		return false
	}
	b.count++
	return true
}

func (l *rateLimiter) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		l.mu.Lock()
		for key, b := range l.data {
			if now.Sub(b.windowStart) > time.Hour {
				delete(l.data, key)
			}
		}
		l.mu.Unlock()
	}
}

// ClientIP returns the caller's IP address. X-Forwarded-For is only honoured
// when the direct peer is a loopback or private address (a co-located reverse
// proxy); otherwise remote callers could spoof the header to evade per-IP
// limits.
func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer := net.ParseIP(host)
	if peer == nil {
		return host
	}
	if !peer.IsLoopback() && !peer.IsPrivate() {
		return peer.String()
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		first := strings.TrimSpace(strings.Split(fwd, ",")[0])
		if ip := net.ParseIP(first); ip != nil {
			return ip.String()
		}
	}
	return peer.String()
}

// IsLocalRequest reports whether the request came directly from the loopback
// interface (used to gate one-time bootstrap endpoints).
func IsLocalRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// failLimiter counts failed authentication attempts per IP so credential
// spraying on authenticated routes is bounded the same way login is.
type failLimiter struct {
	limit  int
	window time.Duration
	mu     sync.Mutex
	data   map[string]*rateBucket
}

func newFailLimiter(limit int, window time.Duration) *failLimiter {
	l := &failLimiter{limit: limit, window: window, data: make(map[string]*rateBucket)}
	go l.cleanup()
	return l
}

func (l *failLimiter) blocked(ip string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.data[ip]
	if !ok || now.Sub(b.windowStart) >= l.window {
		return false
	}
	return b.count >= l.limit
}

func (l *failLimiter) fail(ip string) {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.data[ip]
	if !ok || now.Sub(b.windowStart) >= l.window {
		l.data[ip] = &rateBucket{count: 1, windowStart: now}
		return
	}
	b.count++
}

func (l *failLimiter) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		l.mu.Lock()
		for key, b := range l.data {
			if now.Sub(b.windowStart) > time.Hour {
				delete(l.data, key)
			}
		}
		l.mu.Unlock()
	}
}

func writeAuthRateLimited(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "60")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = w.Write([]byte(`{"error":"too many requests, please slow down"}`))
}
