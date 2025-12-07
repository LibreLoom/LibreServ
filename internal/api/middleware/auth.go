package middleware

import (
	"context"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
)

// ContextKey type for context values
type ContextKey string

const (
	// UserContextKey is the context key for the authenticated user
	UserContextKey ContextKey = "user"
	// UserIDContextKey is used for simpler user_id access
	UserIDContextKey ContextKey = "user_id"
)

// User represents the authenticated user stored in context
type User struct {
	ID       string
	Username string
	Role     string
}

// AuthConfig holds configuration for the auth middleware
type AuthConfig struct {
	AuthService *auth.Service
	DevMode     bool // If true, allows "dev-token" for testing
}

// Auth returns a middleware that validates JWT tokens
func Auth(cfg *AuthConfig) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Get Authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, `{"error": "Authorization header required"}`, http.StatusUnauthorized)
				return
			}

			// Check Bearer token format
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
				http.Error(w, `{"error": "Invalid authorization header format"}`, http.StatusUnauthorized)
				return
			}

			token := parts[1]
			if token == "" {
				http.Error(w, `{"error": "Token required"}`, http.StatusUnauthorized)
				return
			}

			var user *User

			// In dev mode, allow "dev-token" for testing
			if cfg.DevMode && token == "dev-token" {
				user = &User{
					ID:       "dev-user",
					Username: "admin",
					Role:     "admin",
				}
			} else {
				// Validate JWT token
				claims, err := cfg.AuthService.ValidateToken(token)
				if err != nil {
					if err == auth.ErrExpiredToken {
						http.Error(w, `{"error": "Token has expired"}`, http.StatusUnauthorized)
						return
					}
					http.Error(w, `{"error": "Invalid token"}`, http.StatusUnauthorized)
					return
				}

				user = &User{
					ID:       claims.UserID,
					Username: claims.Username,
					Role:     claims.Role,
				}
			}

			// Add user to context
			ctx := context.WithValue(r.Context(), UserContextKey, user)
			ctx = context.WithValue(ctx, UserIDContextKey, user.ID)
			ctx = context.WithValue(ctx, "user_id", user.ID) // Also as plain string key for handlers
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetUser retrieves the authenticated user from context
func GetUser(ctx context.Context) *User {
	user, ok := ctx.Value(UserContextKey).(*User)
	if !ok {
		return nil
	}
	return user
}

// RequireRole returns a middleware that requires a specific role
func RequireRole(role string) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := GetUser(r.Context())
			if user == nil {
				http.Error(w, `{"error": "Authentication required"}`, http.StatusUnauthorized)
				return
			}

			if user.Role != role && user.Role != "admin" {
				http.Error(w, `{"error": "Insufficient permissions"}`, http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
