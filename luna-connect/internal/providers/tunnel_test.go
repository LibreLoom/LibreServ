package providers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateTunnelFetchesTokenWhenCreateOmitsIt(t *testing.T) {
	t.Parallel()
	var posts, gets int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/cfd_tunnel"):
			posts++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"result":  map[string]any{"id": "tun-1", "token": ""},
			})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/token"):
			gets++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"result":  "fetched-token-value",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	c := &TunnelClient{HTTP: srv.Client(), BaseURL: srv.URL}
	creds, err := c.CreateTunnel("acct", "tok", "luna-demo")
	if err != nil {
		t.Fatalf("CreateTunnel: %v", err)
	}
	if posts != 1 || gets != 1 {
		t.Fatalf("expected 1 create + 1 token fetch, got posts=%d gets=%d", posts, gets)
	}
	if creds.TunnelID != "tun-1" || creds.Token != "fetched-token-value" {
		t.Fatalf("unexpected creds: %+v", creds)
	}
}

func TestCreateTunnelRejectsEmptyToken(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"result":  map[string]any{"id": "tun-2", "token": ""},
			})
		case r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"result":  "",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	c := &TunnelClient{HTTP: srv.Client(), BaseURL: srv.URL}
	_, err := c.CreateTunnel("acct", "tok", "luna-empty")
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("expected empty-token error, got %v", err)
	}
}

func TestCreateTunnelMockMode(t *testing.T) {
	t.Parallel()
	c := &TunnelClient{MockMode: true}
	creds, err := c.CreateTunnel("acct", "tok", "demo")
	if err != nil {
		t.Fatal(err)
	}
	if creds.Token == "" || !strings.HasPrefix(creds.TunnelID, "mock-") {
		t.Fatalf("unexpected mock creds: %+v", creds)
	}
}
