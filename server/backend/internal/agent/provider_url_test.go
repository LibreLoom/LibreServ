package agent

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateInferenceBaseURL(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		raw     string
		wantErr string
	}{
		{name: "empty ok", raw: ""},
		{name: "https public", raw: "https://api.openai.com/v1"},
		{name: "loopback http", raw: "http://127.0.0.1:11434/v1"},
		{name: "localhost http", raw: "http://localhost:11434/v1"},
		{name: "http non-loopback", raw: "http://example.com/v1", wantErr: "must use https"},
		{name: "metadata hostname", raw: "https://metadata.google.internal/", wantErr: "cloud metadata"},
		{name: "metadata IP", raw: "http://169.254.169.254/", wantErr: "cloud metadata"},
		{name: "private LAN", raw: "https://192.168.1.10/v1", wantErr: "blocked address"},
		{name: "CGNAT metadata", raw: "https://100.100.100.200/", wantErr: "cloud metadata"},
		{name: "ipv4-compatible loopback encoding of private", raw: "https://[::192.168.0.1]/v1", wantErr: "blocked address"},
		{name: "bad scheme", raw: "ftp://example.com/v1", wantErr: "http or https"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := ValidateInferenceBaseURL(tc.raw)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("ValidateInferenceBaseURL(%q) unexpected err: %v", tc.raw, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("ValidateInferenceBaseURL(%q) err=%v, want substring %q", tc.raw, err, tc.wantErr)
			}
		})
	}
}

func TestIsBlockedInferenceIP(t *testing.T) {
	t.Parallel()
	if isBlockedInferenceIP(net.ParseIP("127.0.0.1")) {
		t.Fatal("loopback should be allowed")
	}
	if !isBlockedInferenceIP(net.ParseIP("10.0.0.1")) {
		t.Fatal("RFC1918 should be blocked")
	}
	if !isBlockedInferenceIP(net.ParseIP("::ffff:10.0.0.1")) {
		t.Fatal("mapped private should be blocked")
	}
	compat := net.IP{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 1}
	if !isBlockedInferenceIP(compat) {
		t.Fatal("IPv4-compatible private should be blocked")
	}
}

func TestInferenceHTTPClientRefusesRedirect(t *testing.T) {
	t.Parallel()
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer final.Close()
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL, http.StatusFound)
	}))
	defer redir.Close()

	client := newInferenceHTTPClient(0)
	resp, err := client.Get(redir.URL)
	if err == nil {
		resp.Body.Close()
		t.Fatal("expected redirect refusal error")
	}
	if !strings.Contains(err.Error(), "redirects are not followed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNewProviderUsesSecureClient(t *testing.T) {
	t.Parallel()
	client := newInferenceHTTPClient(0)
	if client == nil || client.CheckRedirect == nil {
		t.Fatal("expected CheckRedirect to be set")
	}
	if err := client.CheckRedirect(nil, nil); err != errInferenceRedirect {
		t.Fatalf("CheckRedirect = %v, want errInferenceRedirect", err)
	}
}
