package security

import (
	"crypto/sha256"
	"crypto/subtle"
	"strings"
)

func BearerToken(header string) string {
	header = strings.TrimSpace(header)
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

func ConstantTimeEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

func AdminAuthorized(header, want string) bool {
	return ConstantTimeEqual(BearerToken(header), want)
}
