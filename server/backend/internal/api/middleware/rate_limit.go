package middleware

import (
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
	// Rate limiting defaults
	defaultSetupLimit      = 30
	defaultAuthLimit       = 120
	defaultUserLimit       = 60  // User management operations
	defaultSupportLimit    = 30  // Support session commands
	defaultGeneralLimit    = 300 // General API operations
	defaultRateLimitWindow = time.Minute
	defaultStrictWindow    = time.Minute
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
	rules         []RateRule
	mu            sync.Mutex
	data          map[string]*bucket
	cleanupTicker *time.Ticker
	stopCh        chan struct{}
	logger        *slog.Logger
}

// globalLimiters tracks all active limiters for cleanup
var (
	globalLimiters   []*limiter
	globalLimitersMu sync.Mutex
)

// StopAllLimiters stops all active rate limiter cleanup goroutines.
// This should be called during application shutdown.
func StopAllLimiters() {
	globalLimitersMu.Lock()
	defer globalLimitersMu.Unlock()

	for _, l := range globalLimiters {
		l.Stop()
	}
	globalLimiters = nil
}

// RateLimitDefault applies conservative limits on setup/auth endpoints.
func RateLimitDefault() func(http.Handler) http.Handler {
	rules := []RateRule{
		{Prefix: "/api/v1/setup", Limit: defaultSetupLimit, Window: defaultRateLimitWindow},
		{Prefix: "/api/v1/auth", Limit: defaultAuthLimit, Window: defaultRateLimitWindow},
	}
	return RateLimit(rules)
}

// RateLimitSensitive applies stricter limits on sensitive operations like user management.
func RateLimitSensitive() func(http.Handler) http.Handler {
	rules := []RateRule{
		{Prefix: "/api/v1/users", Limit: defaultUserLimit, Window: defaultStrictWindow},
		{Prefix: "/api/v1/support", Limit: defaultSupportLimit, Window: defaultStrictWindow},
	}
	return RateLimit(rules)
}

// RateLimitGeneral applies standard limits on general API operations.
func RateLimitGeneral() func(http.Handler) http.Handler {
	rules := []RateRule{
		{Prefix: "/api/v1", Limit: defaultGeneralLimit, Window: defaultRateLimitWindow},
	}
	return RateLimit(rules)
}

// RateLimit applies simple fixed-window limits.
func RateLimit(rules []RateRule) func(http.Handler) http.Handler {
	l := &limiter{
		rules:         rules,
		data:          make(map[string]*bucket),
		stopCh:        make(chan struct{}),
		logger:        slog.Default().With("component", "rate_limiter"),
		cleanupTicker: time.NewTicker(5 * time.Minute), // Cleanup every 5 minutes
	}

	// Register for global cleanup
	globalLimitersMu.Lock()
	globalLimiters = append(globalLimiters, l)
	globalLimitersMu.Unlock()

	// Start background cleanup goroutine
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

// cleanupRoutine periodically removes stale entries to prevent memory leaks
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

// cleanupStaleEntries removes entries that are older than the max window
func (l *limiter) cleanupStaleEntries() {
	l.mu.Lock()
	defer l.mu.Unlock()

	// Find the maximum window duration among all rules
	maxWindow := time.Minute // default
	for _, rule := range l.rules {
		if rule.Window > maxWindow {
			maxWindow = rule.Window
		}
	}

	// Allow entries to be stale for up to 2x the max window before cleanup
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
		l.logger.Debug("cleaned up stale rate limit entries",
			"removed", removed,
			"remaining", len(l.data),
		)
	}
}

// Stop gracefully shuts down the limiter's background goroutine
// Safe to call multiple times
func (l *limiter) Stop() {
	select {
	case <-l.stopCh:
		// Already closed, do nothing
		return
	default:
		close(l.stopCh)
	}
}
