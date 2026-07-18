package polar

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// MaxWebhookAge is the maximum age of a webhook timestamp before it's rejected.
const MaxWebhookAge = 5 * time.Minute

// VerifyWebhook verifies a Standard Webhooks signature and returns the payload.
// The secret must be base64-decoded before HMAC computation.
// Headers: webhook-id, webhook-timestamp, webhook-signature.
func VerifyWebhook(body []byte, headers http.Header, secret string) ([]byte, error) {
	msgID := headers.Get("Webhook-Id")
	msgTimestamp := headers.Get("Webhook-Timestamp")
	msgSignature := headers.Get("Webhook-Signature")

	if msgID == "" || msgTimestamp == "" || msgSignature == "" {
		return nil, errors.New("missing required webhook headers")
	}

	// Verify timestamp to prevent replay attacks
	ts, err := strconv.ParseInt(msgTimestamp, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid timestamp: %w", err)
	}
	age := time.Since(time.Unix(ts, 0))
	if age > MaxWebhookAge {
		return nil, fmt.Errorf("webhook timestamp too old: %s", age)
	}
	if age < -MaxWebhookAge {
		return nil, fmt.Errorf("webhook timestamp in future: %s", age)
	}

	// Decode the base64 secret
	secretBytes, err := base64.StdEncoding.DecodeString(secret)
	if err != nil {
		// Polar secrets may not be base64 encoded; use raw bytes
		secretBytes = []byte(secret)
	}

	// Compute expected signature: HMAC-SHA256 of "msg_id.timestamp.body"
	signedContent := fmt.Sprintf("%s.%s.%s", msgID, msgTimestamp, string(body))
	mac := hmac.New(sha256.New, secretBytes)
	mac.Write([]byte(signedContent))
	expectedSig := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	// The signature header is space-delimited to support key rotation
	// Format: "v1,<base64sig> v1,<base64sig>"
	for _, sig := range splitSignatures(msgSignature) {
		if hmac.Equal([]byte(sig), []byte(expectedSig)) {
			return body, nil
		}
	}

	return nil, errors.New("webhook signature verification failed")
}

// splitSignatures parses the "v1,<sig> v1,<sig>" format into a list of base64 signatures.
func splitSignatures(header string) []string {
	var sigs []string
	for _, part := range strings.Split(header, " ") {
		if strings.HasPrefix(part, "v1,") {
			sigs = append(sigs, strings.TrimPrefix(part, "v1,"))
		}
	}
	return sigs
}
