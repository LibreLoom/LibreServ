package scheduler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// newTestRegistrarServer returns a test HTTP server that mocks the Cloudflare
// Registrar API for GetDomain, ListDomains, and CheckDomain endpoints.
func newTestRegistrarServer(expiresAt string, autoRenew bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPut:
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}})
		case r.Method == http.MethodPost:
			// POST domain-check
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": map[string]any{
					"domains": []any{
						map[string]any{
							"name":         "test.com",
							"registrable":  true,
							"pricing": map[string]any{
								"registration_cost": "10.11",
								"renewal_cost":      "10.11",
								"currency":          "USD",
							},
						},
					},
				},
				"success": true,
			})
		case r.Method == http.MethodGet && r.URL.Path != "":
			// Could be GET single domain or list — return single for path with domain name.
			pathParts := splitPath(r.URL.Path)
			if len(pathParts) >= 5 {
				// GET /accounts/{id}/registrar/domains/{name}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"result": map[string]any{
						"name":       "test.com",
						"expires_at": expiresAt,
						"auto_renew": autoRenew,
						"locked":     false,
						"status":     "active",
					},
					"success": true,
					"errors":  []any{},
				})
			} else {
				// GET /accounts/{id}/registrar/domains (list)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"result": []any{
						map[string]any{
							"name":       "test.com",
							"expires_at": expiresAt,
							"auto_renew": autoRenew,
							"status":     "active",
						},
					},
					"success": true,
					"errors":  []any{},
				})
			}
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}})
		}
	}))
}

func splitPath(p string) []string {
	var parts []string
	for _, s := range splitSlash(p) {
		if s != "" {
			parts = append(parts, s)
		}
	}
	return parts
}

func splitSlash(s string) []string {
	var result []string
	current := ""
	for _, c := range s {
		if c == '/' {
			result = append(result, current)
			current = ""
		} else {
			current += string(c)
		}
	}
	result = append(result, current)
	return result
}

func TestSyncDomainsUpdatesExpiry(t *testing.T) {
	db := database.OpenTestDB(t)

	// Insert a tunnel provider with CF credentials.
	_, err := db.Exec(`INSERT INTO service_providers (id, service, name, credentials_json, settings_json, enabled)
		VALUES ($1, 'tunnel', 'test', '{"api_token":"tok"}', '{"account_id":"acct"}', TRUE)`,
		"sp-test")
	if err != nil {
		t.Fatalf("insert provider: %v", err)
	}

	futureExpiry := time.Now().AddDate(1, 0, 0).Format(time.RFC3339)
	ts := newTestRegistrarServer(futureExpiry, true)
	defer ts.Close()

	registrar := providers.NewRegistrarClient(ts.Client())
	registrar.SetBaseURL(ts.URL)

	billingSvc := billing.NewService(db)
	sched := New(db, registrar, billingSvc, time.Hour)

	// Insert a device + custom domain with NULL expires_at.
	accountID := "acc-test-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', 'free')`,
		accountID, accountID+"@test.com")
	deviceID := "dev-test-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, plan_id) VALUES ($1, $2, 'free')`, deviceID, accountID)
	_, _ = db.Exec(`INSERT INTO custom_domains (id, device_id, domain, registered_via, auto_renew, status)
		VALUES ($1, $2, 'test.com', 'cloudflare', TRUE, 'active')`,
		"dom-test", deviceID)

	if err := sched.SyncDomains(); err != nil {
		t.Fatalf("syncDomains: %v", err)
	}

	// Verify expires_at was updated from CF.
	var expiresAt *time.Time
	_ = db.QueryRow("SELECT expires_at FROM custom_domains WHERE domain = 'test.com'").Scan(&expiresAt)
	if expiresAt == nil || expiresAt.IsZero() {
		t.Fatal("expected expires_at to be populated after sync")
	}
}

func TestSyncDomainsRevokesExpiredGrace(t *testing.T) {
	db := database.OpenTestDB(t)

	_, err := db.Exec(`INSERT INTO service_providers (id, service, name, credentials_json, settings_json, enabled)
		VALUES ($1, 'tunnel', 'test', '{"api_token":"tok"}', '{"account_id":"acct"}', TRUE)`,
		"sp-test")
	if err != nil {
		t.Fatalf("insert provider: %v", err)
	}

	pastExpiry := time.Now().AddDate(0, 0, -1).Format(time.RFC3339)
	ts := newTestRegistrarServer(pastExpiry, false)
	defer ts.Close()

	registrar := providers.NewRegistrarClient(ts.Client())
	registrar.SetBaseURL(ts.URL)

	billingSvc := billing.NewService(db)
	sched := New(db, registrar, billingSvc, time.Hour)

	accountID := "acc-grace-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', 'free')`,
		accountID, accountID+"@test.com")
	deviceID := "dev-grace-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, plan_id) VALUES ($1, $2, 'free')`, deviceID, accountID)
	// Insert a grace domain that has already expired.
	_, _ = db.Exec(`INSERT INTO custom_domains (id, device_id, domain, registered_via, auto_renew, status, expires_at)
		VALUES ($1, $2, 'expired.com', 'cloudflare', FALSE, 'grace', $3)`,
		"dom-grace", deviceID, time.Now().AddDate(0, 0, -1))

	if err := sched.SyncDomains(); err != nil {
		t.Fatalf("syncDomains: %v", err)
	}

	var status string
	_ = db.QueryRow("SELECT status FROM custom_domains WHERE domain = 'expired.com'").Scan(&status)
	if status != "expired" {
		t.Fatalf("expected status='expired', got %q", status)
	}
}

func TestSyncDomainsDetectsOrphans(t *testing.T) {
	db := database.OpenTestDB(t)

	_, err := db.Exec(`INSERT INTO service_providers (id, service, name, credentials_json, settings_json, enabled)
		VALUES ($1, 'tunnel', 'test', '{"api_token":"tok"}', '{"account_id":"acct"}', TRUE)`,
		"sp-test")
	if err != nil {
		t.Fatalf("insert provider: %v", err)
	}

	futureExpiry := time.Now().AddDate(1, 0, 0).Format(time.RFC3339)
	ts := newTestRegistrarServer(futureExpiry, true)
	defer ts.Close()

	registrar := providers.NewRegistrarClient(ts.Client())
	registrar.SetBaseURL(ts.URL)

	billingSvc := billing.NewService(db)
	sched := New(db, registrar, billingSvc, time.Hour)

	// No custom_domains rows — the CF domain "test.com" is an orphan.
	// This should not error, just log a warning.
	if err := sched.SyncDomains(); err != nil {
		t.Fatalf("syncDomains with orphans: %v", err)
	}
}
