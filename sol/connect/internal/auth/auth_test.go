package auth

import (
	"strings"
	"testing"
	"time"
)

func TestPasswordHashAndVerify(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if hash == "correct horse battery staple" {
		t.Fatal("password was not hashed")
	}
	if err := VerifyPassword(hash, "correct horse battery staple"); err != nil {
		t.Fatalf("VerifyPassword correct value: %v", err)
	}
	if err := VerifyPassword(hash, "wrong"); err == nil {
		t.Fatal("VerifyPassword accepted wrong value")
	}
}

func TestTOTPGenerationAndVerification(t *testing.T) {
	secret, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret: %v", err)
	}
	if len(secret) != 32 {
		t.Fatalf("secret length = %d", len(secret))
	}

	code, err := GenerateTOTPCode(secret, time.Now())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	if len(code) != 6 || !VerifyTOTP(secret, code) {
		t.Fatalf("generated code %q did not verify", code)
	}
	if VerifyTOTP(secret, "123") || VerifyTOTP(secret, "000000") {
		t.Fatal("invalid code verified")
	}
	if _, err := GenerateTOTPCode("not-base32!", time.Now()); err == nil {
		t.Fatal("invalid secret did not fail")
	}
}

func TestTOTPURI(t *testing.T) {
	uri := TOTPURI("SECRET", "user@example.com", "LibreServ Connect")
	for _, part := range []string{"otpauth://totp/", "user@example.com", "secret=SECRET", "issuer=LibreServ Connect"} {
		if !strings.Contains(uri, part) {
			t.Fatalf("URI %q missing %q", uri, part)
		}
	}
}
