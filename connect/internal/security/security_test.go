package security

import "testing"

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
