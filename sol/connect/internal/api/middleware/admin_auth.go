package middleware

import (
	"context"
	"database/sql"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

type adminContext struct{}

// AdminAuth authenticates admin requests. Supports both session tokens (from /admin/login)
// and static admin token (backward compat via config).
func AdminAuth(db *sql.DB) func(http.Handler) http.Handler {
	fails := newFailLimiter(10, time.Minute)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := ClientIP(r)
			if fails.blocked(ip) {
				writeAuthRateLimited(w)
				return
			}

			token := extractBearer(r)
			if token == "" {
				fails.fail(ip)
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}

			// Try session-based auth first
			hash := hashToken(token)
			var adminID string
			var expiresAt time.Time
			err := db.QueryRowContext(r.Context(),
				"SELECT admin_id, expires_at FROM admin_sessions WHERE token_hash = $1", hash).
				Scan(&adminID, &expiresAt)
			if err == nil {
				if time.Now().After(expiresAt) {
					fails.fail(ip)
					http.Error(w, `{"error":"session expired"}`, http.StatusUnauthorized)
					return
				}
				ctx := context.WithValue(r.Context(), adminContext{}, adminID)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			// Fall back to static token. Compare in constant time so a
			// mis-cased or mistyped secret does not leak through EqualFold
			// or short-circuit byte compares.
			expected := config.C.Auth.AdminTokenSecret
			if expected == "" {
				http.Error(w, `{"error":"admin auth not configured"}`, http.StatusServiceUnavailable)
				return
			}
			if security.ConstantTimeEqual(token, expected) {
				ctx := context.WithValue(r.Context(), adminContext{}, "static-admin")
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			fails.fail(ip)
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		})
	}
}

// GetAdminID returns the admin ID from the context.
func GetAdminID(ctx context.Context) string {
	id, _ := ctx.Value(adminContext{}).(string)
	return id
}

// CreateAdminSession creates a new admin session and returns the token.
func CreateAdminSession(db *sql.DB, adminID string) (string, error) {
	token := adminID + "_" + security.RandomHex(32)
	hash := hashToken(token)

	ttl := config.C.Auth.SessionTTLHours
	if ttl == 0 {
		ttl = 168
	}
	expiresAt := time.Now().Add(time.Duration(ttl) * time.Hour)

	_, err := db.Exec(
		`INSERT INTO admin_sessions (id, admin_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
		security.GenerateID("asess"), adminID, hash, expiresAt)
	if err != nil {
		return "", err
	}

	return token, nil
}

// WithAdminID attaches an admin ID to a context for testing.
func WithAdminID(ctx context.Context, adminID string) context.Context {
	return context.WithValue(ctx, adminContext{}, adminID)
}
