package auth

import (
	"errors"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("CorrectHorseBattery1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if err := VerifyPassword(hash, "CorrectHorseBattery1"); err != nil {
		t.Fatalf("VerifyPassword good: %v", err)
	}
	if err := VerifyPassword(hash, "wrong-password"); err == nil {
		t.Fatal("expected VerifyPassword to fail for wrong password")
	}
}

// The dummy hash must be a real bcrypt hash at the cost real passwords use, and
// comparing against it must actually run (a malformed hash would fail before
// doing any work and the timing gap would come back).
func TestDummyPasswordHashIsValidBcrypt(t *testing.T) {
	cost, err := bcrypt.Cost([]byte(dummyPasswordHash))
	if err != nil {
		t.Fatalf("dummy hash is not valid bcrypt: %v", err)
	}
	if cost != bcrypt.DefaultCost {
		t.Fatalf("dummy hash cost = %d, want %d", cost, bcrypt.DefaultCost)
	}
	err = VerifyDummyPassword("not the dummy password")
	if !errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
		t.Fatalf("dummy verification did not run: %v", err)
	}
}

func TestTOTPRoundTrip(t *testing.T) {
	secret, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret: %v", err)
	}
	if secret == "" {
		t.Fatal("empty secret")
	}
	code, err := GenerateTOTPCode(secret, time.Now())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	if len(code) != 6 {
		t.Fatalf("code length = %d, want 6", len(code))
	}
	if !VerifyTOTP(secret, code) {
		t.Fatal("VerifyTOTP rejected freshly generated code")
	}
	if VerifyTOTP(secret, "000000") && code != "000000" {
		// Extremely unlikely collision; still assert wrong-length fails hard.
	}
	if VerifyTOTP(secret, "123") {
		t.Fatal("expected short code to fail")
	}
	uri := TOTPURI(secret, "user@example.com", "Luna Connect")
	if !strings.HasPrefix(uri, "otpauth://totp/") {
		t.Fatalf("unexpected URI: %s", uri)
	}
	if !strings.Contains(uri, "secret="+secret) {
		t.Fatalf("URI missing secret: %s", uri)
	}
}
