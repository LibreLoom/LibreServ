package security

import (
	"strings"
	"testing"
)

func TestOSSTokenMatchesOfficialStrength(t *testing.T) {
	a := NormalizeToken(OSSHexToken())
	b := NormalizeToken(OfficialBookletToken())
	if len(a) < 16 || len(a) != len(b) {
		t.Fatalf("oss %q official %q", a, b)
	}
	if strings.Contains(a, "-") {
		t.Fatalf("normalized still grouped: %s", a)
	}
}

func TestOfficialShape(t *testing.T) {
	tok := NormalizeToken(OfficialBookletToken())
	if !IsOfficialShape(tok) {
		t.Fatalf("official shape %s", tok)
	}
}
