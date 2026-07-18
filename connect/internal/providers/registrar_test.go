package providers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegistrarSearchDomains(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer cf-token" {
			t.Fatalf("auth = %q", r.Header.Get("Authorization"))
		}
		if !strings.Contains(r.URL.Path, "/registrar/domain-search") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("q") != "smith-family" {
			t.Fatalf("query = %q", r.URL.Query().Get("q"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"domains": []map[string]any{
					{
						"name":        "smithfamily.com",
						"registrable": true,
						"tier":        "standard",
						"pricing": map[string]any{
							"currency":          "USD",
							"registration_cost": "8.57",
							"renewal_cost":      "8.57",
						},
					},
					{
						"name":        "smithfamily.net",
						"registrable": true,
						"tier":        "standard",
						"pricing": map[string]any{
							"currency":          "USD",
							"registration_cost": "10.11",
							"renewal_cost":      "10.11",
						},
					},
				},
			},
			"success": true,
			"errors":  []any{},
		})
	}))
	defer ts.Close()

	client := NewRegistrarClient(ts.Client())
	client.baseURL = ts.URL

	results, err := client.SearchDomains("acct-123", "cf-token", "smith-family", 5)
	if err != nil {
		t.Fatalf("search domains: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0].Name != "smithfamily.com" {
		t.Fatalf("first result = %q", results[0].Name)
	}
	if results[0].RegistrationCost != "8.57" {
		t.Fatalf("registration cost = %q", results[0].RegistrationCost)
	}
}

func TestRegistrarCheckDomain(t *testing.T) {
	var requestBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &requestBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"domains": []map[string]any{
					{
						"name":        "smith-family.net",
						"registrable": true,
						"tier":        "standard",
						"pricing": map[string]any{
							"currency":          "USD",
							"registration_cost": "10.11",
							"renewal_cost":      "10.11",
						},
					},
				},
			},
			"success": true,
		})
	}))
	defer ts.Close()

	client := NewRegistrarClient(ts.Client())
	client.baseURL = ts.URL

	result, err := client.CheckDomain("acct-123", "cf-token", "smith-family.net")
	if err != nil {
		t.Fatalf("check domain: %v", err)
	}
	if !result.Registrable {
		t.Fatal("expected domain to be registrable")
	}
	if result.RegistrationCost != "10.11" {
		t.Fatalf("registration cost = %q", result.RegistrationCost)
	}

	// Verify request body contained the domain
	domains, ok := requestBody["domains"].([]any)
	if !ok || len(domains) != 1 {
		t.Fatalf("expected 1 domain in request, got %v", requestBody["domains"])
	}
	if domains[0] != "smith-family.net" {
		t.Fatalf("domain in request = %v", domains[0])
	}
}

func TestRegistrarCheckDomainUnavailable(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"domains": []map[string]any{
					{
						"name":        "taken.com",
						"registrable": false,
						"reason":      "domain_unavailable",
					},
				},
			},
			"success": true,
		})
	}))
	defer ts.Close()

	client := NewRegistrarClient(ts.Client())
	client.baseURL = ts.URL

	result, err := client.CheckDomain("acct-123", "cf-token", "taken.com")
	if err != nil {
		t.Fatalf("check domain: %v", err)
	}
	if result.Registrable {
		t.Fatal("expected domain to be unregistrable")
	}
	if result.Reason != "domain_unavailable" {
		t.Fatalf("reason = %q", result.Reason)
	}
}

func TestRegistrarRegisterDomain(t *testing.T) {
	var requestBody map[string]any
	registerCalled := false
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/registrar/registrations") && r.Method == http.MethodPost {
			registerCalled = true
			body, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(body, &requestBody); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": map[string]any{
					"domain_name": "smith-family.net",
					"state":       "succeeded",
				},
				"success": true,
				"errors":  []any{},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	client := NewRegistrarClient(ts.Client())
	client.baseURL = ts.URL

	err := client.RegisterDomain("acct-123", "cf-token", "smith-family.net")
	if err != nil {
		t.Fatalf("register domain: %v", err)
	}
	if !registerCalled {
		t.Fatal("register was not called")
	}
	if requestBody["domain_name"] != "smith-family.net" {
		t.Fatalf("domain_name = %v", requestBody["domain_name"])
	}
}

func TestRegistrarMissingCredentials(t *testing.T) {
	client := NewRegistrarClient(nil)
	_, err := client.SearchDomains("", "token", "test", 5)
	if err == nil {
		t.Fatal("expected error for missing account ID")
	}
	_, err = client.CheckDomain("acct", "", "test.com")
	if err == nil {
		t.Fatal("expected error for missing API token")
	}
	err = client.RegisterDomain("", "token", "test.com")
	if err == nil {
		t.Fatal("expected error for missing account ID")
	}
}
