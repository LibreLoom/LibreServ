package util

import (
	"net/http"
	"testing"
)

func TestSecureHTTPClient_RefusesRedirects(t *testing.T) {
	if SecureHTTPClient == nil {
		t.Fatal("SecureHTTPClient is nil")
	}
	if SecureHTTPClient.Timeout <= 0 {
		t.Fatalf("SecureHTTPClient.Timeout = %v, want > 0", SecureHTTPClient.Timeout)
	}
	if SecureHTTPClient.CheckRedirect == nil {
		t.Fatal("expected CheckRedirect to be set")
	}
	err := SecureHTTPClient.CheckRedirect(&http.Request{}, nil)
	if err != errSecureHTTPRedirect {
		t.Fatalf("CheckRedirect = %v, want %v", err, errSecureHTTPRedirect)
	}
	// Even after several prior hops, still refuse (no ≤5 allowance).
	via := []*http.Request{{}, {}, {}, {}}
	err = SecureHTTPClient.CheckRedirect(&http.Request{}, via)
	if err != errSecureHTTPRedirect {
		t.Fatalf("CheckRedirect with via = %v, want %v", err, errSecureHTTPRedirect)
	}
}
