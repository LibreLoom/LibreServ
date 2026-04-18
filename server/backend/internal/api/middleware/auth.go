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
	UserContextKey   ContextKey = "user"
	UserIDContextKey ContextKey = "user_id"
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

			// Check if attempting to use dev token (compile-time excluded from production builds)
			if token == "dev-token" {
				// Always reject dev tokens - they should only be used in local development
				// with code compiled without the production tag
				slog.Warn("Dev token authentication attempt blocked",
					"remote_addr", r.RemoteAddr,
					"path", r.URL.Path,
				)
				response.Unauthorized(w, "Dev tokens are not allowed")
				return
			} else {
				claims, err := cfg.AuthService.ValidateAccessToken(token)
				if err != nil {
					slog.Debug("Auth middleware: token validation failed", "path", r.URL.Path, "error", err.Error())
					if err == auth.ErrExpiredToken {
						response.Unauthorized(w, "Your session has expired. Please log in again.")
						return
					}
					response.Unauthorized(w, "Invalid authentication token")
					return
				}

				user = &User{
					ID:       claims.UserID,
					Username: claims.Username,
					Role:     claims.Role,
				}
			}

			ctx := context.WithValue(r.Context(), UserContextKey, user)
			ctx = context.WithValue(ctx, UserIDContextKey, user.ID)
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
