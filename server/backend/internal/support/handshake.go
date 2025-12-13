package support

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// HandshakeSignature returns HMAC(secret, code|role|nonce|ts)
func HandshakeSignature(secret, code, role, nonce string, ts int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	payload := strings.Join([]string{code, role, nonce, strconv.FormatInt(ts, 10)}, "|")
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyHandshake validates a signature and time skew.
func VerifyHandshake(secret, code, role, nonce, sig string, ts int64, skew time.Duration) bool {
	expected := HandshakeSignature(secret, code, role, nonce, ts)
	now := time.Now().Unix()
	if sig == "" || !hmac.Equal([]byte(expected), []byte(sig)) {
		return false
	}
	diff := time.Duration(abs64(now-ts)) * time.Second
	return diff <= skew
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
