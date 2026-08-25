package middleware

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

const DeviceContextKey = "connect_device_id"

type deviceContext struct{}

// DeviceAuth authenticates devices using their Connect key as a bearer token.
func DeviceAuth(db *sql.DB) func(http.Handler) http.Handler {
	fails := newFailLimiter(20, time.Minute)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := ClientIP(r)
			if fails.blocked(ip) {
				writeAuthRateLimited(w)
				return
			}

			key := extractBearer(r)
			if key == "" {
				fails.fail(ip)
				http.Error(w, `{"error":"missing Connect key"}`, http.StatusUnauthorized)
				return
			}

			hash := hashToken(key)
			var deviceID string
			var isActive bool
			err := db.QueryRowContext(r.Context(),
				`SELECT d.id, d.is_active FROM devices d
				 JOIN connect_keys ck ON d.connect_key_id = ck.id
				 WHERE ck.key_hash = $1 AND ck.status = 'active'`, hash).
				Scan(&deviceID, &isActive)
			if err == sql.ErrNoRows {
				fails.fail(ip)
				http.Error(w, `{"error":"invalid or inactive Connect key"}`, http.StatusUnauthorized)
				return
			}
			if err != nil {
				http.Error(w, `{"error":"authentication error"}`, http.StatusInternalServerError)
				return
			}
			if !isActive {
				fails.fail(ip)
				http.Error(w, `{"error":"device is not active"}`, http.StatusUnauthorized)
				return
			}

			// Update last seen
			_, _ = db.ExecContext(r.Context(),
				"UPDATE devices SET last_seen_at = $1 WHERE id = $2", time.Now(), deviceID)

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
