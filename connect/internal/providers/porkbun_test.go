package providers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPorkbunCreateRecord(t *testing.T) {
	var requestBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/dns/create/") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/dns/create/libreloom.org" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &requestBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if requestBody["apikey"] != "apikey-1" {
			t.Fatalf("apikey=%v", requestBody["apikey"])
		}
		if requestBody["secretapikey"] != "secret-1" {
			t.Fatalf("secretapikey=%v", requestBody["secretapikey"])
		}
		if requestBody["name"] != "abc123" {
			t.Fatalf("name=%v", requestBody["name"])
		}
		if requestBody["type"] != "A" {
			t.Fatalf("type=%v", requestBody["type"])
		}
		if requestBody["content"] != "203.0.113.1" {
			t.Fatalf("content=%v", requestBody["content"])
		}
		if ttl, ok := requestBody["ttl"].(float64); !ok || ttl != 600 {
			t.Fatalf("ttl=%v", requestBody["ttl"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":  "SUCCESS",
			"id":      "12345",
			"message": "",
		})
	}))
	defer ts.Close()

	client := NewPorkbunClient(ts.Client())
	client.baseURL = ts.URL

	managed, err := client.CreateRecord("apikey-1", "secret-1", "libreloom.org", "abc123", "A", "203.0.113.1", 600)
	if err != nil {
		t.Fatalf("create record: %v", err)
	}
	if !managed {
		t.Fatal("expected dns_managed=true")
	}
}

func TestPorkbunCreateRecordMissingCredentials(t *testing.T) {
	client := NewPorkbunClient(nil)
	_, err := client.CreateRecord("", "", "libreloom.org", "abc", "A", "1.2.3.4", 600)
	if err == nil {
		t.Fatal("expected error for missing credentials")
	}
}
