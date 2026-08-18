package middleware

import (
	"context"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"log/slog"
)

var trustedProxyNets []*net.IPNet

func init() {
	trustedEnv := os.Getenv("LIBRESERV_TRUSTED_PROXIES")
	if trustedEnv != "" {
		for _, entry := range strings.Split(trustedEnv, ",") {
			entry = strings.TrimSpace(entry)
			if entry == "" {
				continue
			}
			if !strings.Contains(entry, "/") {
				if ip := net.ParseIP(entry); ip != nil {
					if ip.To4() != nil {
						entry += "/32"
					} else {
						entry += "/128"
					}
				}
			}
			_, cidr, err := net.ParseCIDR(entry)
			if err != nil {
				continue
			}
			trustedProxyNets = append(trustedProxyNets, cidr)
		}
	}
	if len(trustedProxyNets) == 0 {
		for _, cidr := range []string{
			"127.0.0.0/8",
			"::1/128",
			"172.16.0.0/12",
			"10.0.0.0/8",
			"192.168.0.0/16",
			"fc00::/7",
		} {
			_, network, err := net.ParseCIDR(cidr)
			if err == nil {
				trustedProxyNets = append(trustedProxyNets, network)
			}
		}
	}
}

const (
	defaultSetupStatusLimit = 180
	defaultSetupCheckLimit  = 60
	defaultSetupWriteLimit  = 5
	defaultAuthLimit        = 120
	defaultRateLimitWindow  = time.Minute
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

func RateLimitDefault() func(http.Handler) http.Handler {
	rules := []RateRule{
		{Prefix: "/api/v1/setup/complete", Limit: defaultSetupWriteLimit, Window: defaultRateLimitWindow, ByUser: false},
		{Prefix: "/api/v1/setup/preflight", Limit: defaultSetupCheckLimit, Window: defaultRateLimitWindow, ByUser: false},
		{Prefix: "/api/v1/setup/status", Limit: defaultSetupStatusLimit, Window: defaultRateLimitWindow, ByUser: false},
		{Prefix: "/api/v1/auth", Limit: defaultAuthLimit, Window: defaultRateLimitWindow, ByUser: false},
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

	if isTrustedProxy(host) {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			parts := strings.Split(forwarded, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				ip := strings.TrimSpace(parts[i])
				if ip != "" {
					return "ip:" + ip
				}
			}
		}
	}

	return "ip:" + host
}

func TrustedProxyNets() []*net.IPNet {
	return trustedProxyNets
}

// IsTrustedProxyIP reports whether ip belongs to a trusted proxy network
// (the same trustedProxyNets list used for X-Forwarded-For parsing and client
// IP detection). Handlers use it to gate headers like X-Forwarded-Proto on
// requests that actually came from Caddy.
func IsTrustedProxyIP(ip net.IP) bool {
	for _, network := range trustedProxyNets {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func isTrustedProxy(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, network := range trustedProxyNets {
		if network.Contains(ip) {
			return true
		}
	}
	return false
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

func GetUserIDFromContext(ctx context.Context) (string, bool) {
	userID, ok := ctx.Value(UserIDContextKey).(string)
	return userID, ok
}
