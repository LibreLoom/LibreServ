package auth

import (
	"errors"
	"net/mail"
	"strings"
	"unicode"
)

var (
	ErrPasswordTooShort          = errors.New("password must be at least 12 characters")
	ErrPasswordMissingComplexity = errors.New("password must include letters and numbers")
	ErrInvalidEmail              = errors.New("enter a valid email address")
)

const MinPasswordLength = 12

func ValidatePassword(password string) error {
	if len(password) < MinPasswordLength {
		return ErrPasswordTooShort
	}
	var hasLetter, hasDigit bool
	for _, r := range password {
		if unicode.IsLetter(r) {
			hasLetter = true
		}
		if unicode.IsDigit(r) {
			hasDigit = true
		}
	}
	if !hasLetter || !hasDigit {
		return ErrPasswordMissingComplexity
	}
	return nil
}

func ValidEmail(email string) bool {
	email = strings.TrimSpace(email)
	if email == "" || !strings.Contains(email, "@") {
		return false
	}
	addr, err := mail.ParseAddress(email)
	if err != nil {
		return false
	}
	parts := strings.Split(addr.Address, "@")
	if len(parts) != 2 || parts[0] == "" || !strings.Contains(parts[1], ".") {
		return false
	}
	return true
}
