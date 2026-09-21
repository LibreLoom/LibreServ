package handlers

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

func accountForDevice(t *testing.T, db *sql.DB, deviceID string) string {
	t.Helper()
	var accountID string
	if err := db.QueryRow(`SELECT account_id FROM devices WHERE id = $1`, deviceID).Scan(&accountID); err != nil {
		t.Fatalf("account for device: %v", err)
	}
	return accountID
}

func TestPortalUsageBillingAndSubscriptions(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "free")
	accountID := accountForDevice(t, db, deviceID)
	h := NewPortalHandler(db)

	if err := h.billing.RecordUsage(deviceID, "free", "smtp", "emails", 4, 0.25, 0.1); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE account_credits SET balance_cents = 900 WHERE device_id = $1`, deviceID); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := db.Exec(
		`INSERT INTO invoices (id, device_id, stripe_invoice_id, status, amount_cents, period_start, period_end, paid_at)
		 VALUES ($1, $2, 'in_test', 'paid', 600, $3, $4, $5)`,
		security.GenerateID("inv"), deviceID, now, now.AddDate(0, 1, 0), now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO credit_transactions (device_id, amount_cents, direction, reason, reference_id)
		 VALUES ($1, 100, 'credit', 'test top-up', 'ref')`, deviceID); err != nil {
		t.Fatal(err)
	}

	usage := portalRequest(t, h, accountID, http.MethodGet, "/portal/usage", "", h.GetUsage)
	if usage.Code != http.StatusOK || !strings.Contains(usage.Body.String(), `"smtp"`) {
		t.Fatalf("usage = %d: %s", usage.Code, usage.Body.String())
	}
	bill := portalRequest(t, h, accountID, http.MethodGet, "/portal/billing", "", h.GetBilling)
	if bill.Code != http.StatusOK || !strings.Contains(bill.Body.String(), `"invoices"`) {
		t.Fatalf("billing = %d: %s", bill.Code, bill.Body.String())
	}

	for body, want := range map[string]int{
		`{}`:                       http.StatusBadRequest,
		`{"plan_id":"not-a-plan"}`: http.StatusBadRequest,
		`{"plan_id":"lite"}`:       http.StatusOK,
		`{"plan_id":"one","device_id":"` + deviceID + `"}`: http.StatusOK,
	} {
		got := portalRequest(t, h, accountID, http.MethodPost, "/portal/subscribe", body, h.Subscribe)
		if got.Code != want {
			t.Fatalf("subscribe %s = %d: %s", body, got.Code, got.Body.String())
		}
	}

	cancel := portalRequest(t, h, accountID, http.MethodPost, "/portal/cancel", `{}`, h.Cancel)
	if cancel.Code != http.StatusOK || !strings.Contains(cancel.Body.String(), "period_end") {
		t.Fatalf("cancel = %d: %s", cancel.Code, cancel.Body.String())
	}
	resume := portalRequest(t, h, accountID, http.MethodPost, "/portal/resume", `{}`, h.ResumeSubscription)
	if resume.Code != http.StatusOK {
		t.Fatalf("resume = %d: %s", resume.Code, resume.Body.String())
	}

	change := portalRequest(t, h, accountID, http.MethodPost, "/portal/change-plan",
		`{"plan_id":"lite","device_id":"`+deviceID+`"}`, h.ChangePlan)
	if change.Code != http.StatusOK {
		t.Fatalf("change plan = %d: %s", change.Code, change.Body.String())
	}
}

func TestPortalEmptyBillingAndCheckout(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)
	h := NewPortalHandler(db)

	for _, fn := range []func(http.ResponseWriter, *http.Request){h.GetUsage, h.GetBilling} {
		got := portalRequest(t, h, accountID, http.MethodGet, "/portal/view", "", fn)
		if got.Code != http.StatusOK {
			t.Fatalf("empty view = %d: %s", got.Code, got.Body.String())
		}
	}
	for body, want := range map[string]int{
		`{}`:                       http.StatusBadRequest,
		`{"plan_id":"not-a-plan"}`: http.StatusBadRequest,
		`{"plan_id":"free"}`:       http.StatusOK,
	} {
		got := portalRequest(t, h, accountID, http.MethodPost, "/portal/checkout", body, h.CreateCheckoutSession)
		if got.Code != want {
			t.Fatalf("checkout %s = %d: %s", body, got.Code, got.Body.String())
		}
	}
	portal := portalRequest(t, h, accountID, http.MethodPost, "/portal/billing-portal", `{}`, h.BillingPortal)
	if portal.Code != http.StatusOK || !strings.Contains(portal.Body.String(), "/billing") {
		t.Fatalf("billing portal = %d: %s", portal.Code, portal.Body.String())
	}
}

func TestPortalConsentRequests(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "free")
	accountID := accountForDevice(t, db, deviceID)
	h := NewPortalHandler(db)
	if _, err := db.Exec(
		`INSERT INTO support_cases (id, device_id, summary, status, scopes_json)
		 VALUES ('case-portal', $1, 'Help', 'open', '[]')`, deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO consent_requests (id, case_id, device_id, requested_by, path, scope_type, status, expires_at, notes)
		 VALUES ('consent-portal', 'case-portal', $1, 'admin', '/data/file', 'file', 'pending', $2, 'please')`,
		deviceID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	list := portalRequest(t, h, accountID, http.MethodGet, "/portal/consent", "", h.GetConsentRequests)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), "consent-portal") {
		t.Fatalf("consent list = %d: %s", list.Code, list.Body.String())
	}
	for body, want := range map[string]int{
		`{}`:                     http.StatusBadRequest,
		`{"decision":"maybe"}`:   http.StatusBadRequest,
		`{"decision":"granted"}`: http.StatusOK,
	} {
		req := "/portal/consent/respond?id=consent-portal"
		got := portalRequest(t, h, accountID, http.MethodPost, req, body, h.RespondConsent)
		if got.Code != want {
			t.Fatalf("consent %s = %d: %s", body, got.Code, got.Body.String())
		}
	}
	notFound := portalRequest(t, h, accountID, http.MethodPost,
		"/portal/consent/respond?id=missing", `{"decision":"denied"}`, h.RespondConsent)
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("missing consent = %d", notFound.Code)
	}
}

func TestPortalMockDomainLifecycle(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "lite")
	accountID := accountForDevice(t, db, deviceID)
	h := NewPortalHandler(db)
	oldMock := config.C.Purchase.MockDomain
	oldStripe := config.C.Stripe.Enabled
	config.C.Purchase.MockDomain = true
	config.C.Stripe.Enabled = false
	t.Cleanup(func() {
		config.C.Purchase.MockDomain = oldMock
		config.C.Stripe.Enabled = oldStripe
	})

	for body, want := range map[string]int{
		`{}`:                       http.StatusBadRequest,
		`{"query":"libreserv"}`:    http.StatusOK,
		`{"query":"my home site"}`: http.StatusOK,
	} {
		got := portalRequest(t, h, accountID, http.MethodPost, "/portal/domains/search", body, h.SearchDomains)
		if got.Code != want {
			t.Fatalf("search %s = %d: %s", body, got.Code, got.Body.String())
		}
	}
	check := portalRequest(t, h, accountID, http.MethodPost, "/portal/domains/check",
		`{"domain":"my-home-site.com"}`, h.CheckDomain)
	if check.Code != http.StatusOK || !strings.Contains(check.Body.String(), `"available":true`) {
		t.Fatalf("check = %d: %s", check.Code, check.Body.String())
	}
	register := portalRequest(t, h, accountID, http.MethodPost, "/portal/domains/register",
		`{"device_id":"`+deviceID+`","domain":"my-home-site.com"}`, h.RegisterDomain)
	if register.Code != http.StatusOK {
		t.Fatalf("register domain = %d: %s", register.Code, register.Body.String())
	}
	list := portalRequest(t, h, accountID, http.MethodGet, "/portal/domains", "", h.ListDomains)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), "my-home-site.com") {
		t.Fatalf("list domains = %d: %s", list.Code, list.Body.String())
	}
	detailsReq := chiRequest(http.MethodGet, "/portal/domains/my-home-site.com", nil,
		map[string]string{"domain": "my-home-site.com"})
	detailsReq = detailsReq.WithContext(middleware.WithCustomerDeviceID(detailsReq.Context(), accountID))
	detailsW := httptest.NewRecorder()
	h.GetDomainDetails(detailsW, detailsReq)
	if detailsW.Code != http.StatusOK {
		t.Fatalf("domain details = %d: %s", detailsW.Code, detailsW.Body.String())
	}

	change := portalRequest(t, h, accountID, http.MethodPost, "/portal/domains/change",
		`{"device_id":"`+deviceID+`","new_domain":"new-home.net"}`, h.ChangeDomain)
	if change.Code != http.StatusOK {
		t.Fatalf("change domain = %d: %s", change.Code, change.Body.String())
	}
	var active string
	if err := db.QueryRow(`SELECT domain FROM custom_domains WHERE device_id = $1 AND status = 'active'`, deviceID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != "new-home.net" {
		t.Fatalf("active domain = %q", active)
	}
}

func TestPortalSubdomainManagement(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "free")
	accountID := accountForDevice(t, db, deviceID)
	h := NewPortalHandler(db)

	for body, want := range map[string]int{
		`{}`:                        http.StatusBadRequest,
		`{"subdomain":"Bad_Name"}`:  http.StatusBadRequest,
		`{"subdomain":"available"}`: http.StatusOK,
	} {
		got := portalRequest(t, h, accountID, http.MethodPost, "/portal/devices/check-subdomain", body, h.CheckSubdomain)
		if got.Code != want {
			t.Fatalf("check subdomain %s = %d: %s", body, got.Code, got.Body.String())
		}
	}
	set := portalRequest(t, h, accountID, http.MethodPost, "/portal/devices/set-subdomain",
		`{"device_id":"`+deviceID+`","subdomain":"my-server"}`, h.SetSubdomain)
	if set.Code != http.StatusOK || !strings.Contains(set.Body.String(), "my-server") {
		t.Fatalf("set subdomain = %d: %s", set.Code, set.Body.String())
	}

	otherDevice := activateDevice(t, db, "free")
	otherAccount := accountForDevice(t, db, otherDevice)
	forbidden := portalRequest(t, h, otherAccount, http.MethodPost, "/portal/devices/set-subdomain",
		`{"device_id":"`+deviceID+`","subdomain":"stolen"}`, h.SetSubdomain)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("foreign set subdomain = %d", forbidden.Code)
	}
	if normalizeSubdomain(" Good-Name ") != "good-name" || normalizeSubdomain("bad_name") != "" {
		t.Fatal("normalizeSubdomain result incorrect")
	}
}

func TestMockDomainResultsAndPriceParsing(t *testing.T) {
	results := mockDomainResults("My Site")
	if len(results) != 5 || results[0]["name"] != "mysite.com" {
		t.Fatalf("mock results = %#v", results)
	}
	if got := mockDomainResults("example.org"); len(got) != 1 || got[0]["name"] != "example.org" {
		t.Fatalf("full-domain results = %#v", got)
	}
	if cents, err := parseDomainCostToCents("11.20"); err != nil || cents != 1120 {
		t.Fatalf("price = %d, %v", cents, err)
	}
	if _, err := parseDomainCostToCents("not-a-price"); err == nil {
		t.Fatal("invalid price accepted")
	}
}

func TestPortalDomainValidationErrors(t *testing.T) {
	h := NewPortalHandler(database.OpenTestDB(t))
	accountID := newVerifiedAccount(t, h.db)
	tests := []struct {
		body string
		fn   func(http.ResponseWriter, *http.Request)
	}{
		{`{}`, h.CheckDomain},
		{`{"domain":"connect.libreloom.org"}`, h.CheckDomain},
		{`{}`, h.RegisterDomain},
		{`{}`, h.ChangeDomain},
	}
	for _, tt := range tests {
		got := portalRequest(t, h, accountID, http.MethodPost, "/portal/domains", tt.body, tt.fn)
		if got.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d: %s", tt.body, got.Code, got.Body.String())
		}
	}
}
