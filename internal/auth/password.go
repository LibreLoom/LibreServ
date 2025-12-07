package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrPasswordTooShort = errors.New("password must be at least 8 characters")
	ErrPasswordMismatch = errors.New("password does not match")
)

const (
	// MinPasswordLength is the minimum allowed password length
	MinPasswordLength = 8
	// BcryptCost is the bcrypt cost factor
	BcryptCost = 12
)

// HashPassword hashes a password using bcrypt
func HashPassword(password string) (string, error) {
	if len(password) < MinPasswordLength {
		return "", ErrPasswordTooShort
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), BcryptCost)
	if err != nil {
		return "", err
	}

	return string(hash), nil
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

// GenerateSecurePassword generates a cryptographically secure random password
func GenerateSecurePassword(length int) (string, error) {
	if length < MinPasswordLength {
		length = MinPasswordLength
	}

	// Generate random bytes
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}

	// Use URL-safe base64 encoding and trim to desired length
	password := base64.URLEncoding.EncodeToString(bytes)
	if len(password) > length {
		password = password[:length]
	}

	return password, nil
}

// GenerateSecureKey generates a cryptographically secure random key (e.g., for JWT secret)
func GenerateSecureKey(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(bytes), nil
}
