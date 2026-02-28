package middleware

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"log/slog"
)

const (
	defaultSetupLimit      = 30
	defaultAuthLimit       = 120
	defaultUserLimit       = 60
	defaultSupportLimit    = 30
	defaultGeneralLimit    = 300
	defaultRateLimitWindow = time.Minute
	defaultStrictWindow    = time.Minute
)

type RateRule struct {
	Prefix string
	Limit  int
	Window time.Duration
	ByUser bool
}

type bucket struct {
	count       int
	windowStart time.Time
}

type limiter struct {
	rules         []RateRule
	mu            sync.Mutex
	data          map[string]*bucket
	cleanupTicker *time.Ticker
	stopCh        chan struct{}
	logger        *slog.Logger
}

var (
	globalLimiters   []*limiter
	globalLimitersMu sync.Mutex
)

func StopAllLimiters() {
	globalLimitersMu.Lock()
	defer globalLimitersMu.Unlock()

	for _, l := range globalLimiters {
		l.Stop()
	}
	globalLimiters = nil
}

func RateLimitDefault() func(http.Handler) http.Handler {
	rules := []RateRule{
		{Prefix: "/api/v1/setup", Limit: defaultSetupLimit, Window: defaultRateLimitWindow, ByUser: false},
		{Prefix: "/api/v1/auth", Limit: defaultAuthLimit, Window: defaultRateLimitWindow, ByUser: false},
	}
	return RateLimit(rules)
}

func RateLimitSensitive() func(http.Handler) http.Handler {
	rules := []RateRule{
		{Prefix: "/api/v1/users", Limit: defaultUserLimit, Window: defaultStrictWindow, ByUser: true},
		{Prefix: "/api/v1/support", Limit: defaultSupportLimit, Window: defaultStrictWindow, ByUser: true},
	}
	return RateLimit(rules)
}

func RateLimitGeneral() func(http.Handler) http.Handler {
	rules := []RateRule{
		{Prefix: "/api/v1", Limit: defaultGeneralLimit, Window: defaultRateLimitWindow, ByUser: true},
	}
	return RateLimit(rules)
}

func RateLimit(rules []RateRule) func(http.Handler) http.Handler {
	l := &limiter{
		rules:         rules,
		data:          make(map[string]*bucket),
		stopCh:        make(chan struct{}),
		logger:        slog.Default().With("component", "rate_limiter"),
		cleanupTicker: time.NewTicker(5 * time.Minute),
	}

	globalLimitersMu.Lock()
	globalLimiters = append(globalLimiters, l)
	globalLimitersMu.Unlock()

	go l.cleanupRoutine()

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
				response.RateLimitExceeded(w, int(reset.Seconds()))
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
	var identifier string

	if rule.ByUser {
		if userID, ok := GetUserIDFromContext(r.Context()); ok && userID != "" {
			identifier = "user:" + userID
		} else {
			identifier = l.extractIP(r)
		}
	} else {
		identifier = l.extractIP(r)
	}

	return rule.Prefix + "::" + identifier
}

func (l *limiter) extractIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}

	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		if len(parts) > 0 {
			trimmed := strings.TrimSpace(parts[0])
			if trimmed != "" {
				host = trimmed
			}
		}
	}

	return "ip:" + host
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

func (l *limiter) cleanupRoutine() {
	for {
		select {
		case <-l.cleanupTicker.C:
			l.cleanupStaleEntries()
		case <-l.stopCh:
			l.cleanupTicker.Stop()
			return
		}
	}
}

func (l *limiter) cleanupStaleEntries() {
	l.mu.Lock()
	defer l.mu.Unlock()

	maxWindow := time.Minute
	for _, rule := range l.rules {
		if rule.Window > maxWindow {
			maxWindow = rule.Window
		}
	}

	staleThreshold := maxWindow * 2
	now := time.Now()

	initialCount := len(l.data)
	for key, b := range l.data {
		if now.Sub(b.windowStart) > staleThreshold {
			delete(l.data, key)
		}
	}

	removed := initialCount - len(l.data)
	if removed > 0 {
		l.logger.Debug("cleaned up stale rate limit entries", "removed", removed, "remaining", len(l.data))
	}
}

func (l *limiter) Stop() {
	select {
	case <-l.stopCh:
		return
	default:
		close(l.stopCh)
	}
}

func GetUserIDFromContext(ctx context.Context) (string, bool) {
	userID, ok := ctx.Value(UserIDContextKey).(string)
	return userID, ok
}
