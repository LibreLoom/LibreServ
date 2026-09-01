package security

import (
	"strings"
	"testing"
)

func TestWebsiteTokenMatchesOfficialStrength(t *testing.T) {
	a := NormalizeToken(WebsiteSetupToken())
	b := NormalizeToken(OfficialDeviceToken())
	if len(a) < 16 || len(a) != len(b) {
		t.Fatalf("website %q official %q", a, b)
	}
	if strings.Contains(a, "-") {
		t.Fatalf("normalized still grouped: %s", a)
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
