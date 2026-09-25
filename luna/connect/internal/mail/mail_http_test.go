package mail

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
	if err != errMailHTTPRedirect {
		t.Fatalf("CheckRedirect = %v, want %v", err, errMailHTTPRedirect)
	}
}

func TestNew_UsesRefuseRedirectClient(t *testing.T) {
	c := New()
	if c == nil || c.HTTP == nil {
		t.Fatal("New() HTTP client is nil")
	}
	if c.HTTP.CheckRedirect == nil {
		t.Fatal("expected CheckRedirect on New() HTTP client")
	}
	err := c.HTTP.CheckRedirect(nil, nil)
	if err != errMailHTTPRedirect {
		t.Fatalf("CheckRedirect = %v, want %v", err, errMailHTTPRedirect)
	}
}
