package middleware

import (
	"context"
	"database/sql"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

type customerContext struct{}

// CustomerAuth authenticates customer portal sessions via bearer token.
func CustomerAuth(db *sql.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := extractBearer(r)
			if token == "" {
				http.Error(w, `{"error":"missing token"}`, http.StatusUnauthorized)
				return
			}

			hash := hashToken(token)
			var deviceID string
			var expiresAt time.Time
			err := db.QueryRowContext(r.Context(),
				"SELECT device_id, expires_at FROM customer_sessions WHERE token_hash = ?", hash).
				Scan(&deviceID, &expiresAt)
			if err == sql.ErrNoRows {
				http.Error(w, `{"error":"invalid or expired session"}`, http.StatusUnauthorized)
				return
			}
			if err != nil {
				http.Error(w, `{"error":"authentication error"}`, http.StatusInternalServerError)
				return
			}

			if time.Now().After(expiresAt) {
				http.Error(w, `{"error":"session expired"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), customerContext{}, deviceID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetCustomerDeviceID returns the device ID from the customer session context.
func GetCustomerDeviceID(ctx context.Context) string {
	id, _ := ctx.Value(customerContext{}).(string)
	return id
}

// CreateCustomerSession creates a new customer session and returns the token.
func CreateCustomerSession(db *sql.DB, deviceID string) (string, error) {
	token := deviceID + "_" + security.RandomHex(32)
	hash := hashToken(token)

	ttl := config.C.Auth.SessionTTLHours
	if ttl == 0 {
		ttl = 168
	}
	expiresAt := time.Now().Add(time.Duration(ttl) * time.Hour)

	_, err := db.Exec(
		`INSERT INTO customer_sessions (id, device_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
		security.GenerateID("sess"), deviceID, hash, expiresAt)
	if err != nil {
		return "", err
	}

	return token, nil
}

// WithCustomerDeviceID attaches a device ID to a context for testing.
func WithCustomerDeviceID(ctx context.Context, deviceID string) context.Context {
	return context.WithValue(ctx, customerContext{}, deviceID)
}
