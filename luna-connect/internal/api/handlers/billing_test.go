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
