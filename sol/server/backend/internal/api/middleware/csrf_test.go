package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/constants"
)

const csrfTestSecret = "csrf-test-secret"
const csrfTestUser = "user-1"

func signedCSRF(secret, userID string, ts int64) string {
	nonce := "0123456789abcdef0123456789abcdef"
	payload := userID + "|" + strconv.FormatInt(ts, 10) + "|" + nonce
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil)) + "|" + strconv.FormatInt(ts, 10) + "|" + nonce
}

func TestValidateCSRFValidToken(t *testing.T) {
	token, err := GenerateCSRF(csrfTestSecret, csrfTestUser)
	if err != nil {
		t.Fatalf("GenerateCSRF: %v", err)
	}
	if !validateCSRF(csrfTestSecret, csrfTestUser, token) {
		t.Fatal("expected freshly generated CSRF token to be valid")
	}
}

func TestValidateCSRFExpiredToken(t *testing.T) {
	ts := time.Now().Add(-constants.CSRFTokenValidityPeriod - time.Minute).Unix()
	token := signedCSRF(csrfTestSecret, csrfTestUser, ts)
	if validateCSRF(csrfTestSecret, csrfTestUser, token) {
		t.Fatal("expected expired CSRF token to be rejected")
	}
}

func TestValidateCSRFFutureTimestampRejected(t *testing.T) {
	ts := time.Now().Add(10 * time.Minute).Unix()
	token := signedCSRF(csrfTestSecret, csrfTestUser, ts)
	if validateCSRF(csrfTestSecret, csrfTestUser, token) {
		t.Fatal("expected CSRF token with future issued-at to be rejected")
	}
}

func TestValidateCSRFTamperedSigRejected(t *testing.T) {
	token, err := GenerateCSRF(csrfTestSecret, csrfTestUser)
	if err != nil {
		t.Fatalf("GenerateCSRF: %v", err)
	}
	// Flip a nibble in the HMAC hex so the signature no longer matches.
	if token[0] == 'a' {
		token = "b" + token[1:]
	} else {
		token = "a" + token[1:]
	}
	if validateCSRF(csrfTestSecret, csrfTestUser, token) {
		t.Fatal("expected tampered CSRF signature to be rejected")
	}
}
