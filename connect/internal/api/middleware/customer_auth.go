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
			var accountID string
			var expiresAt time.Time
			err := db.QueryRowContext(r.Context(),
				"SELECT account_id, expires_at FROM customer_sessions WHERE token_hash = $1", hash).
				Scan(&accountID, &expiresAt)
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

			ctx := context.WithValue(r.Context(), customerContext{}, accountID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetCustomerDeviceID returns the account ID from the customer session context.
// (Named for backward compat — actually returns account ID.)
func GetCustomerDeviceID(ctx context.Context) string {
	id, _ := ctx.Value(customerContext{}).(string)
	return id
}

// CreateCustomerSession creates a new customer session and returns the token.
func CreateCustomerSession(db *sql.DB, accountID string) (string, error) {
	token := accountID + "_" + security.RandomHex(32)
	hash := hashToken(token)

	ttl := config.C.Auth.SessionTTLHours
	if ttl == 0 {
		ttl = 168
	}
	expiresAt := time.Now().Add(time.Duration(ttl) * time.Hour)

	_, err := db.Exec(
		`INSERT INTO customer_sessions (id, account_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
		security.GenerateID("sess"), accountID, hash, expiresAt)
	if err != nil {
		return "", err
	}

	return token, nil
}

// WithCustomerDeviceID attaches an account ID to a context for testing.
func WithCustomerDeviceID(ctx context.Context, accountID string) context.Context {
	return context.WithValue(ctx, customerContext{}, accountID)
}
