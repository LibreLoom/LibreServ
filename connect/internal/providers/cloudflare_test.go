package providers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudflareCreateRecord(t *testing.T) {
	var dnsRequestBody map[string]any
	zoneLookupCalled := false
	recordCreated := false

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify auth header
		if r.Header.Get("Authorization") != "Bearer cf-token-123" {
			t.Fatalf("auth header = %q", r.Header.Get("Authorization"))
		}

		if strings.HasPrefix(r.URL.Path, "/zones") && r.URL.Query().Get("name") != "" {
			// Zone lookup
			zoneLookupCalled = true
			if r.URL.Query().Get("name") != "servers.libreloom.org" {
				t.Fatalf("zone query = %q", r.URL.Query().Get("name"))
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": []map[string]any{
					{"id": "zone-abc-123", "name": "servers.libreloom.org"},
				},
				"success": true,
				"errors":  []any{},
			})
			return
		}

		if strings.HasPrefix(r.URL.Path, "/zones/zone-abc-123/dns_records") {
			// Record creation
			recordCreated = true
			if r.Method != http.MethodPost {
				t.Fatalf("method = %s, want POST", r.Method)
			}
			body, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(body, &dnsRequestBody); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if dnsRequestBody["type"] != "A" {
				t.Fatalf("type = %v", dnsRequestBody["type"])
			}
			if dnsRequestBody["name"] != "myserver.servers.libreloom.org" {
				t.Fatalf("name = %v", dnsRequestBody["name"])
			}
			if dnsRequestBody["content"] != "203.0.113.1" {
				t.Fatalf("content = %v", dnsRequestBody["content"])
			}
			if ttl, ok := dnsRequestBody["ttl"].(float64); !ok || ttl != 600 {
				t.Fatalf("ttl = %v", dnsRequestBody["ttl"])
			}
			if proxied, ok := dnsRequestBody["proxied"].(bool); !ok || proxied {
				t.Fatalf("proxied = %v", dnsRequestBody["proxied"])
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result":  map[string]any{"id": "record-123"},
				"success": true,
				"errors":  []any{},
			})
			return
		}

		http.NotFound(w, r)
	}))
	defer ts.Close()

	client := NewCloudflareClient(ts.Client())
	client.baseURL = ts.URL

	managed, err := client.CreateRecord("cf-token-123", "", "servers.libreloom.org", "myserver", "A", "203.0.113.1", 600)
	if err != nil {
		t.Fatalf("create record: %v", err)
	}
	if !managed {
		t.Fatal("expected dns_managed=true")
	}
	if !zoneLookupCalled {
		t.Fatal("zone lookup was not called")
	}
	if !recordCreated {
		t.Fatal("record was not created")
	}
}

func TestCloudflareCreateRecordFullHostname(t *testing.T) {
	// When the name already contains a dot (full hostname), it should be used as-is.
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/dns_records") && r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			var req map[string]any
			_ = json.Unmarshal(body, &req)
			if req["name"] != "myserver.servers.libreloom.org" {
				t.Fatalf("name = %v, expected full hostname", req["name"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result":  map[string]any{"id": "record-123"},
				"success": true,
				"errors":  []any{},
			})
		} else {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": []map[string]any{
					{"id": "zone-abc-123", "name": "servers.libreloom.org"},
				},
				"success": true,
				"errors":  []any{},
			})
		}
	}))
	defer ts.Close()

	client := NewCloudflareClient(ts.Client())
	client.baseURL = ts.URL

	_, err := client.CreateRecord("cf-token-123", "", "servers.libreloom.org", "myserver.servers.libreloom.org", "A", "1.2.3.4", 600)
	if err != nil {
		t.Fatalf("create record: %v", err)
	}
}

func TestCloudflareCreateRecordMissingToken(t *testing.T) {
	client := NewCloudflareClient(nil)
	_, err := client.CreateRecord("", "", "libreloom.org", "abc", "A", "1.2.3.4", 600)
	if err == nil {
		t.Fatal("expected error for missing API token")
	}
}
