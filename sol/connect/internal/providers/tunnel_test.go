package providers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTunnelCreateTunnel(t *testing.T) {
	var requestBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer cf-token-123" {
			t.Fatalf("auth header = %q", r.Header.Get("Authorization"))
		}
		if !strings.Contains(r.URL.Path, "/cfd_tunnel") {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &requestBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if requestBody["name"] != "libreserv-abc123" {
			t.Fatalf("name = %v", requestBody["name"])
		}
		if requestBody["config_src"] != "cloudflare" {
			t.Fatalf("config_src = %v", requestBody["config_src"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"id":     "tunnel-abc-123",
				"name":   "libreserv-abc123",
				"status": "inactive",
				"token":  "eyJhIjoiNWFiNGU5Z...",
			},
			"success": true,
			"errors":  []any{},
		})
	}))
	defer ts.Close()

	client := NewTunnelClient(ts.Client())
	client.baseURL = ts.URL

	creds, err := client.CreateTunnel("acct-123", "cf-token-123", "libreserv-abc123")
	if err != nil {
		t.Fatalf("create tunnel: %v", err)
	}
	if creds.TunnelID != "tunnel-abc-123" {
		t.Fatalf("tunnel ID = %q", creds.TunnelID)
	}
	if creds.Token != "eyJhIjoiNWFiNGU5Z..." {
		t.Fatalf("token = %q", creds.Token)
	}
}

func TestTunnelCreateMissingCredentials(t *testing.T) {
	client := NewTunnelClient(nil)
	_, err := client.CreateTunnel("", "token", "test")
	if err == nil {
		t.Fatal("expected error for missing account ID")
	}
	_, err = client.CreateTunnel("acct", "", "test")
	if err == nil {
		t.Fatal("expected error for missing API token")
	}
}

func TestTunnelConfigureIngress(t *testing.T) {
	var requestBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("method = %s, want PUT", r.Method)
		}
		if !strings.Contains(r.URL.Path, "/configurations") {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &requestBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}})
	}))
	defer ts.Close()

	client := NewTunnelClient(ts.Client())
	client.baseURL = ts.URL

	err := client.ConfigureIngress("acct-123", "cf-token", "tunnel-123", "myserver.servers.libreloom.org", "http://localhost:8080")
	if err != nil {
		t.Fatalf("configure ingress: %v", err)
	}

	// Verify the ingress config was sent correctly
	config, ok := requestBody["config"].(map[string]any)
	if !ok {
		t.Fatal("missing config in request")
	}
	ingress, ok := config["ingress"].([]any)
	if !ok || len(ingress) != 2 {
		t.Fatalf("expected 2 ingress rules, got %v", config["ingress"])
	}
	first := ingress[0].(map[string]any)
	if first["hostname"] != "myserver.servers.libreloom.org" {
		t.Fatalf("hostname = %v", first["hostname"])
	}
	if first["service"] != "http://localhost:8080" {
		t.Fatalf("service = %v", first["service"])
	}
}

func TestTunnelDeleteTunnel(t *testing.T) {
	deleteCalled := false
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deleteCalled = true
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer ts.Close()

	client := NewTunnelClient(ts.Client())
	client.baseURL = ts.URL

	err := client.DeleteTunnel("acct-123", "cf-token", "tunnel-123")
	if err != nil {
		t.Fatalf("delete tunnel: %v", err)
	}
	if !deleteCalled {
		t.Fatal("delete was not called")
	}
}

func TestTunnelGetStatus(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("method = %s, want GET", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"id":     "tunnel-123",
				"name":   "libreserv-test",
				"status": "healthy",
			},
			"success": true,
		})
	}))
	defer ts.Close()

	client := NewTunnelClient(ts.Client())
	client.baseURL = ts.URL

	status, err := client.GetTunnelStatus("acct-123", "cf-token", "tunnel-123")
	if err != nil {
		t.Fatalf("get status: %v", err)
	}
	if status.Status != "healthy" {
		t.Fatalf("status = %q, want healthy", status.Status)
	}
	if status.ID != "tunnel-123" {
		t.Fatalf("ID = %q", status.ID)
	}
}
