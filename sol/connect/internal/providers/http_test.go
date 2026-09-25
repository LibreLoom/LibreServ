package providers

import (
	"net/http"
	"testing"
	"time"
)

func TestDefaultHTTPClient_RefusesRedirects(t *testing.T) {
	client := defaultHTTPClient()
	if client == nil {
		t.Fatal("defaultHTTPClient returned nil")
	}
	if client.Timeout != 15*time.Second {
		t.Fatalf("Timeout = %v, want 15s", client.Timeout)
	}
	if client.CheckRedirect == nil {
		t.Fatal("expected CheckRedirect to be set")
	}
	err := client.CheckRedirect(&http.Request{}, nil)
	if err != errProviderHTTPRedirect {
		t.Fatalf("CheckRedirect = %v, want %v", err, errProviderHTTPRedirect)
	}
	via := []*http.Request{{}, {}, {}}
	err = client.CheckRedirect(&http.Request{}, via)
	if err != errProviderHTTPRedirect {
		t.Fatalf("CheckRedirect with via = %v, want %v", err, errProviderHTTPRedirect)
	}
}
