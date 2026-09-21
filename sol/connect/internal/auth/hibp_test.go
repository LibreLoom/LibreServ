package auth

import (
	"crypto/sha1" //nolint:gosec
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckBreachedPassword(t *testing.T) {
	sum := sha1.Sum([]byte("password123")) //nolint:gosec
	full := strings.ToUpper(hex.EncodeToString(sum[:]))
	suffix := full[5:]

	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(suffix + ":999\nDEADBEEF:1\n"))
	}))
	t.Cleanup(stub.Close)
	SetHIBPRangeURL(stub.URL + "/")
	t.Cleanup(func() { SetHIBPRangeURL("https://api.pwnedpasswords.com/range/") })

	breached, err := CheckBreachedPassword("password123")
	if err != nil {
		t.Fatalf("breached check err: %v", err)
	}
	if !breached {
		t.Fatal("expected breached=true for password123")
	}

	stubClean := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("DEADBEEF:1\n"))
	}))
	t.Cleanup(stubClean.Close)
	SetHIBPRangeURL(stubClean.URL + "/")

	breached, err = CheckBreachedPassword("Tr0ub4dor&3-Good!")
	if err != nil {
		t.Fatalf("clean check err: %v", err)
	}
	if breached {
		t.Fatal("expected breached=false for unique password")
	}
}

func TestRejectBreachedPasswordFailsOpen(t *testing.T) {
	SetHIBPRangeURL("http://127.0.0.1:1/range/")
	t.Cleanup(func() { SetHIBPRangeURL("https://api.pwnedpasswords.com/range/") })
	if msg := RejectBreachedPassword("whatever123"); msg != "" {
		t.Fatalf("unreachable API must fail open, got %q", msg)
	}
}
