package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// HashPassword hashes a password using bcrypt.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

// VerifyPassword checks a password against a bcrypt hash.
func VerifyPassword(hash, password string) error {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
}

// GenerateTOTPSecret generates a random TOTP secret (20 bytes, base32 encoded).
func GenerateTOTPSecret() (string, error) {
	secret := make([]byte, 20)
	if _, err := rand.Read(secret); err != nil {
		return "", fmt.Errorf("generate totp secret: %w", err)
	}
	return base32.StdEncoding.EncodeToString(secret), nil
}

// GenerateTOTPCode generates a 6-digit TOTP code for the given secret at the current time.
func GenerateTOTPCode(secret string, t time.Time) (string, error) {
	// Decode base32 secret
	key, err := base32.StdEncoding.DecodeString(secret)
	if err != nil {
		return "", fmt.Errorf("decode totp secret: %w", err)
	}

	// TOTP uses 30-second time steps
	counter := t.Unix() / 30
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, uint64(counter))

	mac := hmac.New(sha1.New, key)
	mac.Write(buf)
	hash := mac.Sum(nil)

	// Dynamic truncation
	offset := int(hash[len(hash)-1] & 0x0f)
	code := binary.BigEndian.Uint32(hash[offset:offset+4]) & 0x7fffffff
	otp := code % 1000000

	return fmt.Sprintf("%06d", otp), nil
}

// VerifyTOTP checks if a TOTP code is valid for the given secret.
// Allows a ±1 time step window to account for clock drift.
func VerifyTOTP(secret, code string) bool {
	if len(code) != 6 {
		return false
	}

	now := time.Now()
	for _, offset := range []int{-30, 0, 30} {
		t := now.Add(time.Duration(offset) * time.Second)
		expected, err := GenerateTOTPCode(secret, t)
		if err != nil {
			continue
		}
		if hmac.Equal([]byte(expected), []byte(code)) {
			return true
		}
	}
	return false
}

// TOTPURI generates the otpauth:// URI for QR code generation.
func TOTPURI(secret, account, issuer string) string {
	return fmt.Sprintf("otpauth://totp/%s:%s?secret=%s&issuer=%s", issuer, account, secret, issuer)
}

// GenerateToken generates a random token (for sessions, API keys, etc.).
func GenerateToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return base32.StdEncoding.EncodeToString(b), nil
}
