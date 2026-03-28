package middleware

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
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

// isProductionEnvironment checks if the application is running in production mode.
// Returns true if the mode is "production" or if the environment variable is not set.
func isProductionEnvironment() bool {
	mode := strings.ToLower(os.Getenv("LIBRESERV_MODE"))
	return mode == "production" || mode == ""
}

func IsDevTokenEnabled() bool {
	return os.Getenv("LIBRESERV_DEV_TOKEN_ENABLED") == "true"
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

			// Check if attempting to use dev token
			if token == "dev-token" {
				// Prevent dev token usage in production
				if isProductionEnvironment() {
					slog.Warn("Dev token authentication attempt blocked in production mode",
						"remote_addr", r.RemoteAddr,
						"path", r.URL.Path,
					)
					response.Unauthorized(w, "Dev tokens are not allowed in production")
					return
				}

				// Allow dev token only if explicitly enabled in non-production
				if cfg.DevMode && IsDevTokenEnabled() {
					user = &User{
						ID:       "dev-user",
						Username: "admin",
						Role:     "admin",
					}
				} else {
					response.Unauthorized(w, "Dev token authentication is disabled")
					return
				}
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
