package security

import (
	"strings"
	"testing"
)

func TestBearerTokenAndAdminAuthorized(t *testing.T) {
	if BearerToken("") != "" || BearerToken("Basic x") != "" {
		t.Fatal("expected empty for non-bearer")
	}
	if got := BearerToken("Bearer secret-token"); got != "secret-token" {
		t.Fatalf("got %q", got)
	}
	if !AdminAuthorized("Bearer abc", "abc") {
		t.Fatal("expected authorized")
	}
	if AdminAuthorized("Bearer abc", "xyz") {
		t.Fatal("expected reject")
	}
	if ConstantTimeEqual("", "x") || ConstantTimeEqual("a", "b") {
		t.Fatal("expected unequal")
	}
	if !ConstantTimeEqual("same", "same") {
		t.Fatal("expected equal")
	}
}

func TestRandomHexHashTokenNewIDHint(t *testing.T) {
	h := RandomHex(8)
	if len(h) != 16 {
		t.Fatalf("hex len=%d", len(h))
	}
	sum := HashToken("tok")
	if len(sum) != 64 {
		t.Fatalf("hash len=%d", len(sum))
	}
	id := NewID("dev")
	if !strings.HasPrefix(id, "dev_") {
		t.Fatalf("id=%s", id)
	}
	if TokenHint("") != "" {
		t.Fatal("empty hint")
	}
	if TokenHint("AB") != "AB" {
		t.Fatalf("short hint")
	}
	if got := TokenHint("ABCDEFGH"); got != "…EFGH" {
		t.Fatalf("hint=%q", got)
	}
}
