package handlers

import (
	"context"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"net"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type adminCtxKey struct{}

const adminAuthFailMax = 10
const adminAuthFailWindowSec = 60

// AdminSessionCookie carries a staff session from /admin/login. It is HttpOnly
// and scoped to /admin, so it never reaches the customer API and never collides
// with the customer session cookie (luna_connect_session on /).
const AdminSessionCookie = "luna_connect_admin_session"

const adminCookiePath = "/admin"

// AdminAuth accepts only a staff session cookie from /admin/login. A static
// Bearer token is not an admin credential: scripts must sign in as a real
// admin, with two-factor authentication, the same as everyone else. Wrong or
// expired cookies count against a per-IP budget in guess_attempts (shared
// across both instances, 10 per minute); a request that sends no credential
// at all does not, so the admin pages' own sign-in probe cannot lock staff out.
func AdminAuth(db *database.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := ClientIP(r)
			key := "admin-auth:" + ip
			fail := func() {
				_ = allowGuess(db, key, adminAuthFailMax, adminAuthFailWindowSec)
			}
			if guessBlocked(db, key, adminAuthFailMax, adminAuthFailWindowSec) {
				JSONError(w, http.StatusTooManyRequests, "Too many failed admin sign-ins from this network. Wait a minute, then try again.")
				return
			}
			c, err := r.Cookie(AdminSessionCookie)
			if err != nil || c.Value == "" {
				JSONError(w, http.StatusUnauthorized, "Admin sign-in required.")
				return
			}
			var adminID string
			var expiresAt int64
			err = db.QueryRow(`SELECT admin_id, expires_at FROM admin_sessions WHERE token_hash = ?`, security.HashToken(c.Value)).
				Scan(&adminID, &expiresAt)
			if err != nil {
				fail()
				clearAdminSessionCookie(w)
				JSONError(w, http.StatusUnauthorized, "Admin sign-in required.")
				return
			}
			if time.Now().Unix() > expiresAt {
				fail()
				clearAdminSessionCookie(w)
				JSONError(w, http.StatusUnauthorized, "Admin session expired. Sign in again.")
				return
			}
			var active int
			_ = db.QueryRow(`SELECT is_active FROM admin_accounts WHERE id = ?`, adminID).Scan(&active)
			if active != 1 {
				fail()
				clearAdminSessionCookie(w)
				JSONError(w, http.StatusForbidden, "This admin account is disabled.")
				return
			}
			next.ServeHTTP(w, r.WithContext(WithAdminID(r.Context(), adminID)))
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

func adminSessionTTL() time.Duration {
	ttl := config.C.Auth.SessionTTLHours
	if ttl <= 0 {
		ttl = 168
	}
	return time.Duration(ttl) * time.Hour
}

// CreateAdminSession stores a new staff session (only its hash is kept) and
// returns the raw token for the session cookie.
func CreateAdminSession(db *database.DB, adminID string) (string, error) {
	token := security.RandomHex(32)
	now := time.Now()
	expires := now.Add(adminSessionTTL()).Unix()
	_, err := db.Exec(
		`INSERT INTO admin_sessions (id, admin_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		security.NewID("asess"), adminID, security.HashToken(token), now.Unix(), expires)
	if err != nil {
		return "", err
	}
	return token, nil
}

// adminSessionToken returns the raw staff session token from the request's cookie, or "".
func adminSessionToken(r *http.Request) string {
	c, err := r.Cookie(AdminSessionCookie)
	if err != nil {
		return ""
	}
	return c.Value
}

func setAdminSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     AdminSessionCookie,
		Value:    token,
		Path:     adminCookiePath,
		HttpOnly: true,
		Secure:   config.CookieSecure(),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(adminSessionTTL().Seconds()),
	})
}

func clearAdminSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     AdminSessionCookie,
		Value:    "",
		Path:     adminCookiePath,
		HttpOnly: true,
		Secure:   config.CookieSecure(),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
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
