package security

import (
	"regexp"
	"strings"
	"testing"
)

func TestConstantTimeEqual(t *testing.T) {
	if !ConstantTimeEqual("admin-test-token", "admin-test-token") {
		t.Fatal("matching secrets should be equal")
	}
	if ConstantTimeEqual("admin-test-token", "ADMIN-TEST-TOKEN") {
		t.Fatal("secrets must match exactly; case folding is not allowed")
	}
	if ConstantTimeEqual("", "") || ConstantTimeEqual("secret", "") || ConstantTimeEqual("", "secret") {
		t.Fatal("empty secrets must never match")
	}
	if ConstantTimeEqual("alpha", "bravo") {
		t.Fatal("different secrets should not be equal")
	}
}

func TestRandomGenerators(t *testing.T) {
	if got := GenerateToken("verify"); !strings.HasPrefix(got, "verify_") || len(got) != len("verify_")+64 {
		t.Fatalf("GenerateToken = %q", got)
	}
	if got := GenerateID("acct"); !strings.HasPrefix(got, "acct_") {
		t.Fatalf("GenerateID = %q", got)
	}
	if got := RandomHex(12); len(got) != 24 {
		t.Fatalf("RandomHex length = %d", len(got))
	}
	if got := RandomPassword(32); len(got) != 32 || !regexp.MustCompile(`^[A-Za-z0-9]+$`).MatchString(got) {
		t.Fatalf("RandomPassword = %q", got)
	}
	if got := RandomString(15); len(got) != 15 {
		t.Fatalf("RandomString length = %d", len(got))
	}
	if got := GenerateConnectKey(); !regexp.MustCompile(`^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$`).MatchString(got) {
		t.Fatalf("GenerateConnectKey = %q", got)
	}
}
