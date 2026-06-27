package middleware

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
)

type ContextKey string

const (
	UserContextKey       ContextKey = "user"
	UserIDContextKey     ContextKey = "user_id"
	AuthMethodContextKey ContextKey = "auth_method"
)

type User struct {
	ID       string
	Username string
	Role     string
}

type AuthConfig struct {
	AuthService *auth.Service
	DevMode     bool
	License     LicenseChecker
	CSRFSecret  string
}

type LicenseChecker interface {
	Valid() bool
	Reason() string
	SupportLevel() string
	LicenseID() string
}

// IsDevTokenEnabled always returns false - dev tokens are disabled for security
// Dev token functionality has been removed to prevent accidental exposure in production
func IsDevTokenEnabled() bool {
	return false
}

func Auth(cfg *AuthConfig) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, err := extractAccessToken(r)
			if err != nil {
				slog.Debug("Auth middleware: no token found", "path", r.URL.Path, "error", err.Error())
				response.Unauthorized(w, "")
				return
			}
			var user *User
			authMethod := "session"

			// Check if attempting to use dev token (compile-time excluded from production builds)
			if token == "dev-token" {
				slog.Warn("Dev token authentication attempt blocked",
					"remote_addr", r.RemoteAddr,
					"path", r.URL.Path,
				)
				response.Unauthorized(w, "Dev tokens are not allowed")
				return
			}

			// Try the JWT session token first.
			claims, err := cfg.AuthService.ValidateAccessToken(token)
			if err == nil {
				user = &User{
					ID:       claims.UserID,
					Username: claims.Username,
					Role:     claims.Role,
				}
			} else if err == auth.ErrExpiredToken {
				response.Unauthorized(w, "Your session has expired. Please log in again.")
				return
			} else if auth.IsAPIToken(token) {
				// Not a valid JWT but looks like an API token — try programmatic auth.
				u, apiErr := cfg.AuthService.ValidateAPIToken(r.Context(), token)
				if apiErr != nil {
					slog.Debug("Auth middleware: api token validation failed", "path", r.URL.Path, "error", apiErr.Error())
					response.Unauthorized(w, "Invalid authentication token")
					return
				}
				user = &User{ID: u.ID, Username: u.Username, Role: u.Role}
				authMethod = "api_token"
			} else {
				slog.Debug("Auth middleware: token validation failed", "path", r.URL.Path, "error", err.Error())
				response.Unauthorized(w, "Invalid authentication token")
				return
			}

			ctx := context.WithValue(r.Context(), UserContextKey, user)
			ctx = context.WithValue(ctx, UserIDContextKey, user.ID)
			ctx = context.WithValue(ctx, AuthMethodContextKey, authMethod)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetUser(ctx context.Context) *User {
	user, ok := ctx.Value(UserContextKey).(*User)
	if !ok {
		return nil
	}
	return user
}

func GetUserID(ctx context.Context) (string, bool) {
	userID, ok := ctx.Value(UserIDContextKey).(string)
	return userID, ok
}

// GetAuthMethod returns how the current request authenticated: "session"
// (JWT/cookie) or "api_token" (long-lived bearer). The CSRF middleware uses
// this to skip bearer-authed requests, which are immune to CSRF.
func GetAuthMethod(ctx context.Context) string {
	m, _ := ctx.Value(AuthMethodContextKey).(string)
	return m
}

func RequireRole(role string) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := GetUser(r.Context())
			if user == nil {
				response.Unauthorized(w, "")
				return
			}

			if user.Role != role && user.Role != "admin" {
				response.Forbidden(w, "You don't have permission to perform this action")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func extractAccessToken(r *http.Request) (string, error) {
	authHeader := r.Header.Get("Authorization")
	if authHeader != "" {
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) == 2 && strings.ToLower(parts[0]) == "bearer" {
			return parts[1], nil
		}
	}

	cookie, err := r.Cookie("libreserv_access")
	if err == nil && cookie.Value != "" {
		return cookie.Value, nil
	}

	return "", errors.New("no access token found")
}
