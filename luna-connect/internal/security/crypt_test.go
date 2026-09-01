package security

import (
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestAtRestReadyRequiresKeyInProduction(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "")
	prev := config.C.Server.AtRestKey
	t.Cleanup(func() { config.C.Server.AtRestKey = prev })
	config.C.Server.AtRestKey = ""
	if err := AtRestReady(); err == nil {
		t.Fatal("expected missing at-rest key error")
	}
}

func TestAtRestReadyDevFallback(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "1")
	prev := config.C.Server.AtRestKey
	t.Cleanup(func() { config.C.Server.AtRestKey = prev })
	config.C.Server.AtRestKey = ""
	if err := AtRestReady(); err != nil {
		t.Fatalf("dev fallback: %v", err)
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "1")
	prev := config.C.Server.AtRestKey
	t.Cleanup(func() { config.C.Server.AtRestKey = prev })
	config.C.Server.AtRestKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	sealed, err := SealString("tunnel-secret")
	if err != nil || !strings.HasPrefix(sealed, "v1:") {
		t.Fatalf("seal %q %v", sealed, err)
	}
	got, err := OpenString(sealed)
	if err != nil || got != "tunnel-secret" {
		t.Fatalf("open %q %v", got, err)
	}
}
