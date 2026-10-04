package security

import (
	"strings"
	"testing"
)

func TestOfficialTokenNormalizesUngrouped(t *testing.T) {
	b := NormalizeToken(OfficialDeviceToken())
	if len(b) < 16 {
		t.Fatalf("official token too short: %q", b)
	}
	if strings.Contains(b, "-") {
		t.Fatalf("normalized still grouped: %s", b)
	}
}

func TestOfficialShape(t *testing.T) {
	tok := NormalizeToken(OfficialDeviceToken())
	if !IsOfficialShape(tok) {
		t.Fatalf("official shape %s", tok)
	}
	if IsOfficialShape("A1B2C3") {
		t.Fatal("short hex must not look official")
	}
}
