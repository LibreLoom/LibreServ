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
					"context": map[string]any{
						"registration": map[string]any{
							"expires_at": "2026-08-15T10:00:00Z",
						},
					},
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

	_, err := client.RegisterDomain("acct-123", "cf-token", "smith-family.net")
	if err != nil {
		t.Fatalf("register domain: %v", err)
	}
	if !registerCalled {
		t.Fatal("register was not called")
	}
	if requestBody["domain_name"] != "smith-family.net" {
		t.Fatalf("domain_name = %v", requestBody["domain_name"])
	}
	if requestBody["auto_renew"] != true {
		t.Fatalf("expected auto_renew=true in request body, got %v", requestBody["auto_renew"])
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
	_, err = client.RegisterDomain("", "token", "test.com")
	if err == nil {
		t.Fatal("expected error for missing account ID")
	}
}

func TestRegistrarGetDomain(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"name":       "smith-family.net",
				"expires_at": "2026-08-15T10:00:00Z",
				"auto_renew": true,
				"locked":     true,
				"status":     "active",
			},
			"success": true,
			"errors":  []any{},
		})
	}))
	defer ts.Close()

	client := NewRegistrarClient(ts.Client())
	client.baseURL = ts.URL

	info, err := client.GetDomain("acct-123", "cf-token", "smith-family.net")
	if err != nil {
		t.Fatalf("get domain: %v", err)
	}
	if info.Name != "smith-family.net" {
		t.Fatalf("name = %q", info.Name)
	}
	if !info.AutoRenew {
		t.Fatal("expected auto_renew=true")
	}
	if !info.Locked {
		t.Fatal("expected locked=true")
	}
	if info.Status != "active" {
		t.Fatalf("status = %q", info.Status)
	}
	if info.ExpiresAt.IsZero() {
		t.Fatal("expected non-zero expires_at")
	}
	if info.ExpiresAt.Year() != 2026 {
		t.Fatalf("expires_at year = %d", info.ExpiresAt.Year())
	}
}

func TestRegistrarListDomains(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": []any{
				map[string]any{
					"name":       "smith-family.net",
					"expires_at": "2026-08-15T10:00:00Z",
					"auto_renew": true,
					"locked":     false,
					"status":     "active",
				},
				map[string]any{
					"name":       "other.com",
					"expires_at": "2027-01-20T00:00:00Z",
					"auto_renew": false,
					"locked":     true,
					"status":     "active",
				},
			},
			"success": true,
			"errors":  []any{},
		})
	}))
	defer ts.Close()

	client := NewRegistrarClient(ts.Client())
	client.baseURL = ts.URL

	domains, err := client.ListDomains("acct-123", "cf-token")
	if err != nil {
		t.Fatalf("list domains: %v", err)
	}
	if len(domains) != 2 {
		t.Fatalf("expected 2 domains, got %d", len(domains))
	}
	if domains[0].Name != "smith-family.net" {
		t.Fatalf("first domain = %q", domains[0].Name)
	}
	if domains[1].Name != "other.com" {
		t.Fatalf("second domain = %q", domains[1].Name)
	}
	if domains[1].AutoRenew {
		t.Fatal("expected second domain auto_renew=false")
	}
}

func TestRegistrarUpdateDomainAutoRenew(t *testing.T) {
	var requestBody map[string]any
	var requestMethod string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestMethod = r.Method
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &requestBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"errors":  []any{},
		})
	}))
	defer ts.Close()

	client := NewRegistrarClient(ts.Client())
	client.baseURL = ts.URL

	if err := client.UpdateDomainAutoRenew("acct-123", "cf-token", "smith-family.net", false); err != nil {
		t.Fatalf("update auto-renew: %v", err)
	}
	if requestMethod != http.MethodPut {
		t.Fatalf("expected PUT, got %s", requestMethod)
	}
	if requestBody["auto_renew"] != false {
		t.Fatalf("expected auto_renew=false in body, got %v", requestBody["auto_renew"])
	}
}

func TestRegistrarGetDomainMissingCredentials(t *testing.T) {
	client := NewRegistrarClient(nil)
	_, err := client.GetDomain("", "token", "test.com")
	if err == nil {
		t.Fatal("expected error for missing account ID")
	}
	_, err = client.GetDomain("acct", "", "test.com")
	if err == nil {
		t.Fatal("expected error for missing API token")
	}
	_, err = client.ListDomains("", "token")
	if err == nil {
		t.Fatal("expected error for missing account ID in ListDomains")
	}
	err = client.UpdateDomainAutoRenew("", "token", "test.com", true)
	if err == nil {
		t.Fatal("expected error for missing account ID in UpdateDomainAutoRenew")
	}
}
