package auth

import (
	"encoding/base64"
	"fmt"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"github.com/skip2/go-qrcode"
	"golang.org/x/crypto/bcrypt"
)

// ----- bcrypt for recovery codes (raw — no password-strength rules) -----

// bcryptHash hashes a recovery code with bcrypt at the default cost.
func bcryptHash(code string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

// bcryptCompare returns nil if code matches the bcrypt hash.
func bcryptCompare(hash, code string) error {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(code))
}

// ----- TOTP -----

// generateTOTPSecret creates a new TOTP secret + otpauth URI for the user.
// Issuer/Account are fixed; the frontend shows the QR + secret for manual entry.
func generateTOTPSecret(username string) (secret, otpauthURI string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "LibreServ",
		AccountName: username,
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		return "", "", err
	}
	return key.Secret(), key.URL(), nil
}

// validateTOTP checks a 6-digit code against the secret (default skew/digits).
func validateTOTP(secret, code string) bool {
	return totp.Validate(code, secret)
}

// qrPNGDataURI returns a base64 PNG data URI encoding s, for <img src=...>.
func qrPNGDataURI(s string) (string, error) {
	png, err := qrcode.Encode(s, qrcode.Medium, 256)
	if err != nil {
		return "", fmt.Errorf("failed to generate qr: %w", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}
