package handlers

import (
	"context"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type adminCtxKey struct{}

// AdminAuth accepts a staff session Bearer from /admin/login, or the static
// server.admin_token (ops / tests).
func AdminAuth(db *database.DB) func(http.Handler) http.Handler {
	fails := newFailLimiter(10, time.Minute)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := ClientIP(r)
			if fails.blocked(ip) {
				JSONError(w, http.StatusTooManyRequests, "Too many failed admin sign-ins from this network. Wait a minute, then try again.")
				return
			}
			token := security.BearerToken(r.Header.Get("Authorization"))
			if token == "" {
				fails.fail(ip)
				JSONError(w, http.StatusUnauthorized, "Admin sign-in required.")
				return
			}
			hash := security.HashToken(token)
			var adminID string
			var expiresAt int64
			err := db.QueryRow(`SELECT admin_id, expires_at FROM admin_sessions WHERE token_hash = ?`, hash).
				Scan(&adminID, &expiresAt)
			if err == nil {
				if time.Now().Unix() > expiresAt {
					fails.fail(ip)
					JSONError(w, http.StatusUnauthorized, "Admin session expired. Sign in again.")
					return
				}
				var active int
				_ = db.QueryRow(`SELECT is_active FROM admin_accounts WHERE id = ?`, adminID).Scan(&active)
				if active != 1 {
					fails.fail(ip)
					JSONError(w, http.StatusForbidden, "This admin account is disabled.")
					return
				}
				next.ServeHTTP(w, r.WithContext(WithAdminID(r.Context(), adminID)))
				return
			}
			if security.AdminAuthorized(r.Header.Get("Authorization"), config.C.Server.AdminToken) {
				next.ServeHTTP(w, r.WithContext(WithAdminID(r.Context(), "static-admin")))
				return
			}
			fails.fail(ip)
			JSONError(w, http.StatusUnauthorized, "Admin sign-in required.")
		})
	}
}

func WithAdminID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, adminCtxKey{}, id)
}

func AdminIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(adminCtxKey{}).(string)
	return id
}

func CreateAdminSession(db *database.DB, adminID string) (string, error) {
	token := security.RandomHex(32)
	ttl := config.C.Auth.SessionTTLHours
	if ttl <= 0 {
		ttl = 168
	}
	now := time.Now()
	expires := now.Add(time.Duration(ttl) * time.Hour).Unix()
	_, err := db.Exec(
		`INSERT INTO admin_sessions (id, admin_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		security.NewID("asess"), adminID, security.HashToken(token), now.Unix(), expires)
	if err != nil {
		return "", err
	}
	return token, nil
}

// requireAdmin allows handlers called with or without AdminAuth middleware
// (tests still pass the static Bearer directly).
func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if AdminIDFrom(r.Context()) != "" {
		return true
	}
	if security.AdminAuthorized(r.Header.Get("Authorization"), config.C.Server.AdminToken) {
		return true
	}
	JSONError(w, http.StatusUnauthorized, "Admin sign-in required.")
	return false
}

func IsLocalRequest(r *http.Request) bool {
	// Behind Caddy/loopback bind, RemoteAddr is always 127.0.0.1. Any client
	// identity header means this is a proxied request, not an on-box seed.
	if strings.TrimSpace(r.Header.Get("X-Forwarded-For")) != "" || strings.TrimSpace(r.Header.Get("X-Real-IP")) != "" {
		return false
	}
	host := remoteHost(r.RemoteAddr)
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

type failLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string][]time.Time
}

func newFailLimiter(limit int, window time.Duration) *failLimiter {
	return &failLimiter{limit: limit, window: window, hits: map[string][]time.Time{}}
}

func (f *failLimiter) blocked(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pruneLocked(key)
	return len(f.hits[key]) >= f.limit
}

func (f *failLimiter) fail(key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pruneLocked(key)
	f.hits[key] = append(f.hits[key], time.Now())
}

func (f *failLimiter) pruneLocked(key string) {
	cut := time.Now().Add(-f.window)
	kept := f.hits[key][:0]
	for _, t := range f.hits[key] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(f.hits, key)
	} else {
		f.hits[key] = kept
	}
}
