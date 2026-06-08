package middleware

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strings"
)

const DeviceContextKey = "connect_device_id"

type deviceContext struct{}

func DeviceAuth(db *sql.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := extractBearer(r)
			if token == "" {
				http.Error(w, `{"error":"missing token"}`, http.StatusUnauthorized)
				return
			}

			hash := hashToken(token)
			var deviceID string
			var isActive bool
			err := db.QueryRowContext(r.Context(),
				"SELECT id, is_active FROM devices WHERE token_hash = ?", hash).Scan(&deviceID, &isActive)
			if err != nil || !isActive {
				http.Error(w, `{"error":"invalid or inactive token"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), deviceContext{}, deviceID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetDeviceID(ctx context.Context) string {
	id, _ := ctx.Value(deviceContext{}).(string)
	return id
}

// WithDeviceID attaches a device ID to a context for testing.
func WithDeviceID(ctx context.Context, deviceID string) context.Context {
	return context.WithValue(ctx, deviceContext{}, deviceID)
}

func extractBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(h, "Bearer ")
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
