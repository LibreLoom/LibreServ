package middleware

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
)

// CSRF protects state-changing requests using a stateless HMAC token.
// Token format: hex(HMAC(secret, userID|ts|nonce))|ts|nonce
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
				response.Unauthorized(w, "")
				return
			}
			token := r.Header.Get("X-CSRF-Token")
			if token == "" {
				response.Forbidden(w, "CSRF token is required")
				return
			}
			if !validateCSRF(secret, user.ID, token) {
				response.Forbidden(w, "Invalid CSRF token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// GenerateCSRF creates a token for a user with a random nonce for uniqueness.
// Token format: hex(HMAC(secret, userID|ts|nonce))|ts|nonce
func GenerateCSRF(secret, userID string) string {
	ts := time.Now().Unix()

	// Generate cryptographically secure random nonce (16 bytes = 32 hex chars)
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		// Fallback to timestamp-based nonce if crypto/rand fails (extremely rare)
		nonceBytes = []byte(strconv.FormatInt(ts, 10))
	}
	nonce := hex.EncodeToString(nonceBytes)

	payload := userID + "|" + strconv.FormatInt(ts, 10) + "|" + nonce
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil)) + "|" + strconv.FormatInt(ts, 10) + "|" + nonce
}

func validateCSRF(secret, userID, token string) bool {
	parts := strings.Split(token, "|")
	// Support both old format (sig|ts) and new format (sig|ts|nonce)
	if len(parts) != 2 && len(parts) != 3 {
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

	// Build payload based on token format
	var payload string
	if len(parts) == 3 {
		// New format with nonce
		nonce := parts[2]
		payload = userID + "|" + tsStr + "|" + nonce
	} else {
		// Legacy format without nonce (for backward compatibility during transition)
		payload = userID + "|" + tsStr
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	expectedSig := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(sig), []byte(expectedSig))
}
