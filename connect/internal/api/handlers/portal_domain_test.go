package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

func TestGetDomainDetailsReturnsRenewalPrice(t *testing.T) {
	db := database.OpenTestDB(t)

	// Insert tunnel provider.
	_, err := db.Exec(`INSERT INTO service_providers (id, service, name, credentials_json, settings_json, enabled)
		VALUES ($1, 'tunnel', 'test', '{"api_token":"tok"}', '{"account_id":"acct"}', TRUE)`,
		"sp-test")
	if err != nil {
		t.Fatalf("insert provider: %v", err)
	}

	// Create account + device + custom domain.
	accountID := "acc-det-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', 'free')`,
		accountID, accountID+"@test.com")
	deviceID := "dev-det-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, plan_id) VALUES ($1, $2, 'free')`, deviceID, accountID)
	_, _ = db.Exec(`INSERT INTO custom_domains (id, device_id, domain, registered_via, registration_cost_cents, renewal_cost_cents, auto_renew, status, expires_at)
		VALUES ($1, $2, 'test.com', 'cloudflare', 1011, 1011, TRUE, 'active', $3)`,
		"dom-det", deviceID, time.Now().AddDate(1, 0, 0))

	// Mock the CF registrar API — GetDomain + CheckDomain.
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": map[string]any{
					"domains": []any{
						map[string]any{
							"name":        "test.com",
							"registrable": true,
							"pricing": map[string]any{
								"registration_cost": "10.11",
								"renewal_cost":      "10.11",
							},
						},
					},
				},
				"success": true,
			})
		} else {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": map[string]any{
					"name":       "test.com",
					"expires_at": time.Now().AddDate(1, 0, 0).Format(time.RFC3339),
					"auto_renew": true,
					"status":     "active",
				},
				"success": true,
			})
		}
	}))
	defer ts.Close()

	h := NewPortalHandler(db)
	h.registrar.SetBaseURL(ts.URL)

	req := httptest.NewRequest(http.MethodGet, "/portal/domains/test.com", nil)
	req = req.WithContext(middleware.WithCustomerDeviceID(req.Context(), accountID))
	w := httptest.NewRecorder()

	h.GetDomainDetails(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["domain"] != "test.com" {
		t.Fatalf("domain = %v", resp["domain"])
	}
	if resp["renewal_price_cents"] == nil {
		t.Fatal("expected renewal_price_cents in response")
	}
}

func TestCancelDomainDisablesAutoRenew(t *testing.T) {
	db := database.OpenTestDB(t)

	_, err := db.Exec(`INSERT INTO service_providers (id, service, name, credentials_json, settings_json, enabled)
		VALUES ($1, 'tunnel', 'test', '{"api_token":"tok"}', '{"account_id":"acct"}', TRUE)`,
		"sp-test")
	if err != nil {
		t.Fatalf("insert provider: %v", err)
	}

	accountID := "acc-can-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', 'free')`,
		accountID, accountID+"@test.com")
	deviceID := "dev-can-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, plan_id) VALUES ($1, $2, 'free')`, deviceID, accountID)
	_, _ = db.Exec(`INSERT INTO custom_domains (id, device_id, domain, registered_via, auto_renew, status, expires_at)
		VALUES ($1, $2, 'cancel.com', 'cloudflare', TRUE, 'active', $3)`,
		"dom-can", deviceID, time.Now().AddDate(1, 0, 0))

	// Mock CF registrar — PUT should be called to disable auto-renew.
	autoRenewCalled := false
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			autoRenewCalled = true
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}})
	}))
	defer ts.Close()

	h := NewPortalHandler(db)
	h.registrar.SetBaseURL(ts.URL)

	req := httptest.NewRequest(http.MethodPost, "/portal/domains/cancel.com/cancel", nil)
	req = req.WithContext(middleware.WithCustomerDeviceID(req.Context(), accountID))
	w := httptest.NewRecorder()

	h.CancelDomain(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !autoRenewCalled {
		t.Fatal("expected CF auto-renew PUT to be called")
	}

	// Verify status changed to 'cancelled' in DB.
	var status string
	_ = db.QueryRow("SELECT status FROM custom_domains WHERE domain = 'cancel.com'").Scan(&status)
	if status != "cancelled" {
		t.Fatalf("expected status='cancelled', got %q", status)
	}
}

func TestChangePlanGraceOnDowngrade(t *testing.T) {
	db := database.OpenTestDB(t)

	_, err := db.Exec(`INSERT INTO service_providers (id, service, name, credentials_json, settings_json, enabled)
		VALUES ($1, 'tunnel', 'test', '{"api_token":"tok"}', '{"account_id":"acct"}', TRUE)`,
		"sp-test")
	if err != nil {
		t.Fatalf("insert provider: %v", err)
	}

	accountID := "acc-plan-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', 'lite')`,
		accountID, accountID+"@test.com")
	deviceID := "dev-plan-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, plan_id) VALUES ($1, $2, 'lite')`, deviceID, accountID)
	_, _ = db.Exec(`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at) VALUES ($1, $2, 'lite', 'active', $3)`,
		"sub-plan", deviceID, time.Now())
	_, _ = db.Exec(`INSERT INTO custom_domains (id, device_id, domain, registered_via, auto_renew, status, expires_at)
		VALUES ($1, $2, 'plan.com', 'cloudflare', TRUE, 'active', $3)`,
		"dom-plan", deviceID, time.Now().AddDate(1, 0, 0))

	// Mock CF registrar.
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}})
	}))
	defer ts.Close()

	h := NewPortalHandler(db)
	h.registrar.SetBaseURL(ts.URL)

	// Change plan to free (downgrade).
	body, _ := json.Marshal(map[string]string{"plan_id": "free", "device_id": deviceID})
	req := httptest.NewRequest(http.MethodPost, "/portal/change-plan", bytes.NewReader(body))
	req = req.WithContext(middleware.WithCustomerDeviceID(req.Context(), accountID))
	w := httptest.NewRecorder()

	h.ChangePlan(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify the custom domain entered grace.
	var status string
	_ = db.QueryRow("SELECT status FROM custom_domains WHERE domain = 'plan.com'").Scan(&status)
	if status != "grace" {
		t.Fatalf("expected domain status='grace' after downgrade, got %q", status)
	}
}
