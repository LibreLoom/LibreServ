package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// CSRF protects state-changing requests using a stateless HMAC token.
// Token format: hex(HMAC(secret, userID|ts))|ts
func CSRF(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if secret == "" {
				next.ServeHTTP(w, r)
				return
			}
			// Only enforce on write methods
			if r.Method != http.MethodPost && r.Method != http.MethodPut && r.Method != http.MethodPatch && r.Method != http.MethodDelete {
				next.ServeHTTP(w, r)
				return
			}
			user := GetUser(r.Context())
			if user == nil {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			token := r.Header.Get("X-CSRF-Token")
			if token == "" {
				http.Error(w, `{"error":"missing csrf token"}`, http.StatusForbidden)
				return
			}
			if !validateCSRF(secret, user.ID, token) {
				http.Error(w, `{"error":"invalid csrf token"}`, http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// GenerateCSRF creates a token for a user.
func GenerateCSRF(secret, userID string) string {
	ts := time.Now().Unix()
	payload := userID + "|" + strconv.FormatInt(ts, 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil)) + "|" + strconv.FormatInt(ts, 10)
}

func validateCSRF(secret, userID, token string) bool {
	parts := strings.Split(token, "|")
	if len(parts) != 2 {
		return false
	}
	sig, tsStr := parts[0], parts[1]
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return false
	}
	// 24h validity
	if time.Since(time.Unix(ts, 0)) > 24*time.Hour {
		return false
	}
	expected := GenerateCSRF(secret, userID)
	expParts := strings.Split(expected, "|")
	return len(expParts) == 2 && hmac.Equal([]byte(expParts[0]), []byte(sig)) && tsStr == expParts[1]
}
