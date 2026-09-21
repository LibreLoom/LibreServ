package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestStripeWebhookLocksBackups(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	cookie := registerAccount(t, acct, "bill@b.co")
	_ = cookie
	var id string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'bill@b.co'`).Scan(&id)
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active', stripe_subscription_id = 'sub_test1' WHERE id = ?`, id)

	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.WebhookSecret = "whsec_test_secret"

	payload := `{"id":"evt_1","object":"event","type":"customer.subscription.deleted","data":{"object":{"id":"sub_test1","object":"subscription","status":"canceled"}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/webhook", strings.NewReader(payload))
	req.Header.Set("Stripe-Signature", stripeTestSig("whsec_test_secret", payload))
	rec := httptest.NewRecorder()
	acct.StripeWebhook(rec, req)
	if rec.Code != 200 {
		t.Fatalf("webhook %d %s", rec.Code, rec.Body.String())
	}
	var has int
	var status, subID string
	_ = d.DB.QueryRow(`SELECT has_card, billing_status, COALESCE(stripe_subscription_id,'') FROM accounts WHERE id = ?`, id).Scan(&has, &status, &subID)
	if has != 0 || status != "canceled" {
		t.Fatalf("lock has=%d status=%s", has, status)
	}
	if subID != "" {
		t.Fatalf("canceled subscription id %q must be cleared so AttachCard can resubscribe", subID)
	}
	var purge int64
	_ = d.DB.QueryRow(`SELECT COALESCE(backup_purge_after,0) FROM accounts WHERE id = ?`, id).Scan(&purge)
	if purge == 0 {
		t.Fatal("deleted subscription should start the 30-day backup purge clock")
	}
}

func TestStripeWebhookInvoiceFailedLocks(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	_ = registerAccount(t, acct, "inv@b.co")
	var id string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'inv@b.co'`).Scan(&id)
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active', stripe_subscription_id = 'sub_fail1' WHERE id = ?`, id)
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.WebhookSecret = "whsec_test_secret"
	payload := `{"id":"evt_2","object":"event","type":"invoice.payment_failed","data":{"object":{"id":"in_1","object":"invoice","subscription":"sub_fail1"}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/webhook", strings.NewReader(payload))
	req.Header.Set("Stripe-Signature", stripeTestSig("whsec_test_secret", payload))
	rec := httptest.NewRecorder()
	acct.StripeWebhook(rec, req)
	if rec.Code != 200 {
		t.Fatalf("webhook %d %s", rec.Code, rec.Body.String())
	}
	var has int
	var status string
	_ = d.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE id = ?`, id).Scan(&has, &status)
	if has != 0 || status != "past_due" {
		t.Fatalf("lock has=%d status=%s", has, status)
	}
}

// Basil+ invoice payloads omit top-level subscription; parent.subscription_details holds it.
func TestStripeWebhookInvoiceFailedLocksBasilParent(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	_ = registerAccount(t, acct, "invbasil@b.co")
	var id string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'invbasil@b.co'`).Scan(&id)
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active', stripe_subscription_id = 'sub_basil1' WHERE id = ?`, id)
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.WebhookSecret = "whsec_test_secret"
	payload := `{"id":"evt_basil","object":"event","type":"invoice.payment_failed","data":{"object":{"id":"in_basil","object":"invoice","parent":{"type":"subscription_details","subscription_details":{"subscription":"sub_basil1"}}}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/webhook", strings.NewReader(payload))
	req.Header.Set("Stripe-Signature", stripeTestSig("whsec_test_secret", payload))
	rec := httptest.NewRecorder()
	acct.StripeWebhook(rec, req)
	if rec.Code != 200 {
		t.Fatalf("webhook %d %s", rec.Code, rec.Body.String())
	}
	var has int
	var status string
	_ = d.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE id = ?`, id).Scan(&has, &status)
	if has != 0 || status != "past_due" {
		t.Fatalf("basil lock has=%d status=%s", has, status)
	}
}

func TestStripeWebhookInvoicePaidUnlocksBasilParent(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	_ = registerAccount(t, acct, "paidbasil@b.co")
	var id string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'paidbasil@b.co'`).Scan(&id)
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = 'past_due', stripe_subscription_id = 'sub_paid1' WHERE id = ?`, id)
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.WebhookSecret = "whsec_test_secret"
	payload := `{"id":"evt_paid","object":"event","type":"invoice.paid","data":{"object":{"id":"in_paid","object":"invoice","parent":{"type":"subscription_details","subscription_details":{"subscription":"sub_paid1"}}}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/webhook", strings.NewReader(payload))
	req.Header.Set("Stripe-Signature", stripeTestSig("whsec_test_secret", payload))
	rec := httptest.NewRecorder()
	acct.StripeWebhook(rec, req)
	if rec.Code != 200 {
		t.Fatalf("webhook %d %s", rec.Code, rec.Body.String())
	}
	var has int
	var status string
	_ = d.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE id = ?`, id).Scan(&has, &status)
	if has != 1 || status != "active" {
		t.Fatalf("basil unlock has=%d status=%s", has, status)
	}
}

func TestSubscriptionIDFromInvoiceJSON(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"legacy string", `{"subscription":"sub_a"}`, "sub_a"},
		{"legacy object", `{"subscription":{"id":"sub_b"}}`, "sub_b"},
		{"basil parent", `{"parent":{"type":"subscription_details","subscription_details":{"subscription":"sub_c"}}}`, "sub_c"},
		{"basil expanded", `{"parent":{"type":"subscription_details","subscription_details":{"subscription":{"id":"sub_d"}}}}`, "sub_d"},
		{"none", `{"id":"in_x"}`, ""},
	}
	for _, tc := range cases {
		if got := subscriptionIDFromInvoiceJSON([]byte(tc.raw)); got != tc.want {
			t.Fatalf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}

func TestStripeWebhookRejectsBadSignature(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.WebhookSecret = "whsec_test_secret"
	payload := `{"id":"evt_1","object":"event","type":"customer.subscription.deleted","data":{"object":{"id":"sub_x"}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/webhook", strings.NewReader(payload))
	req.Header.Set("Stripe-Signature", "t=1,v1=deadbeef")
	rec := httptest.NewRecorder()
	acct.StripeWebhook(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("bad sig %d %s", rec.Code, rec.Body.String())
	}
}

func TestStripeWebhookDisabledReturns503(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = false
	config.C.Stripe.WebhookSecret = "whsec_test_secret"
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/webhook", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	acct.StripeWebhook(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled stripe %d %s", rec.Code, rec.Body.String())
	}
}

func TestStripeWebhookMissingSecretReturns400(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = "sk_test_live"
	config.C.Stripe.WebhookSecret = ""
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/webhook", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	acct.StripeWebhook(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing webhook secret %d %s", rec.Code, rec.Body.String())
	}
}

func TestStripeWebhookLoadsSecretFromDB(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	prev := config.C.Stripe
	t.Cleanup(func() {
		config.C.Stripe = prev
		providers.SetStripeRuntimeDB(nil)
		providers.CaptureStripeBase()
	})
	config.C.Stripe = config.StripeConfig{Enabled: false, SecretKey: "sk_yaml"}
	providers.CaptureStripeBase()
	providers.SetStripeRuntimeDB(d.DB)

	svc := providers.NewService(d.DB)
	_, err := svc.Create("stripe", "Stripe", map[string]string{
		"secret_key":     "sk_from_db",
		"webhook_secret": "whsec_from_db",
	}, map[string]string{"publishable_key": "pk_from_db", "price_id": "price_db"}, true)
	if err != nil {
		t.Fatal(err)
	}

	payload := `{"id":"evt_db","object":"event","type":"invoice.paid","data":{"object":{"id":"in_db","object":"invoice","subscription":"sub_nope"}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/webhook", strings.NewReader(payload))
	req.Header.Set("Stripe-Signature", stripeTestSig("whsec_from_db", payload))
	rec := httptest.NewRecorder()
	acct.StripeWebhook(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("webhook from db secret %d %s", rec.Code, rec.Body.String())
	}
}

func TestAdminBearerConstantTime(t *testing.T) {
	if security.AdminAuthorized("Bearer abc", "abc") != true {
		t.Fatal("match")
	}
	if security.AdminAuthorized("Bearer abc", "abd") {
		t.Fatal("mismatch")
	}
	if security.AdminAuthorized("Bearer abc", "") {
		t.Fatal("empty want")
	}
}

func stripeTestSig(secret, payload string) string {
	ts := time.Now().Unix()
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", ts, payload)
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}
