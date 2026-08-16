package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"

	"golang.org/x/crypto/bcrypt"
)

var (
	// ErrPasswordTooShort indicates a password doesn't meet minimum length.
	ErrPasswordTooShort = errors.New("password must be at least 12 characters")
	// ErrPasswordMissingComplexity indicates a password is missing required character types.
	ErrPasswordMissingComplexity = errors.New("password must include letters and numbers")
	// ErrPasswordMismatch indicates a hash mismatch for a supplied password.
	ErrPasswordMismatch = errors.New("password does not match")
)

const (
	// MinPasswordLength is the minimum allowed password length
	MinPasswordLength = 12
	// BcryptCost is the bcrypt cost factor
	BcryptCost = 12
)

// dummyPasswordHash is a real bcrypt hash (cost 12) of a random string.
// It is compared against the supplied password on the user-not-found path so
// that non-existent usernames take roughly the same time as a wrong password
// for an existing user. A malformed hash would short-circuit bcrypt and
// re-enable username enumeration via timing.
var dummyPasswordHash = func() string {
	h, err := bcrypt.GenerateFromPassword([]byte("dummy-timing-attenuation-value"), BcryptCost)
	if err != nil {
		// bcrypt.GenerateFromPassword only errors on invalid cost; BcryptCost is
		// a valid constant, so this is unreachable. Fall back to a known-good
		// hash rather than panicking.
		return "$2a$12$0123456789012345678901uPxFQ3BqgQ7vR3qJr6p2Kq9Xu8qT2e"
	}
	return string(h)
}()

// HashPassword hashes a password using bcrypt
func HashPassword(password string) (string, error) {
	if err := validatePasswordStrength(password); err != nil {
		return "", err
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), BcryptCost)
	if err != nil {
		return "", err
	}

	return string(hash), nil
}

// validatePasswordStrength checks that a password meets strength requirements
func validatePasswordStrength(password string) error {
	if len(password) < MinPasswordLength {
		return ErrPasswordTooShort
	}
	var hasLetter, hasDigit bool
	for _, r := range password {
		switch {
		case 'a' <= r && r <= 'z', 'A' <= r && r <= 'Z':
			hasLetter = true
		case '0' <= r && r <= '9':
			hasDigit = true
		}
	}
	if !hasLetter || !hasDigit {
		return ErrPasswordMissingComplexity
	}
	return nil
}

// VerifyPassword verifies a password against a hash
func VerifyPassword(hash, password string) error {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	if err != nil {
		if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
			return ErrPasswordMismatch
		}
		return err
	}
	return nil
}

// GenerateSecureKey generates a cryptographically secure random key (e.g., for JWT secret)
func GenerateSecureKey(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(bytes), nil
}
