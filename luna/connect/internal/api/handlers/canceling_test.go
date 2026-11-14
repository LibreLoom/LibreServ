package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

// "Turn off payment" leaves the account linked to its subscription as
// "canceling" until Stripe ends it FinalChargeDelay later. These tests pin
// that no webhook in that window can turn backups back on or start the
// 30-day countdown, and that the end finishes cleanly.

func cancelingAccount(t *testing.T, d Deps, email, sub string) string {
	t.Helper()
	id := checkoutAccount(t, d, email)
	if _, err := d.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = 'canceling', stripe_subscription_id = ? WHERE id = ?`, sub, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func sendWebhook(t *testing.T, d Deps, payload string) {
	t.Helper()
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.WebhookSecret = "whsec_test_secret"
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/webhook", strings.NewReader(payload))
	req.Header.Set("Stripe-Signature", stripeTestSig("whsec_test_secret", payload))
	rec := httptest.NewRecorder()
	AccountHandler{Deps: d}.StripeWebhook(rec, req)
	if rec.Code != 200 {
		t.Fatalf("webhook %d %s", rec.Code, rec.Body.String())
	}
}

func accountBilling(t *testing.T, d Deps, id string) (has int, status, sub string, purge int64) {
	t.Helper()
	_ = d.DB.QueryRow(`SELECT has_card, billing_status, COALESCE(stripe_subscription_id, ''), COALESCE(backup_purge_after, 0) FROM accounts WHERE id = ?`, id).
		Scan(&has, &status, &sub, &purge)
	return
}

func TestCancelingIgnoresTheUpdateThatSchedulesTheEnd(t *testing.T) {
	d := testDeps(t)
	id := cancelingAccount(t, d, "sched@b.co", "sub_c1")
	sendWebhook(t, d, `{"id":"evt_c1","object":"event","type":"customer.subscription.updated","data":{"object":{"id":"sub_c1","object":"subscription","status":"active","cancel_at":1999999999}}}`)
	if has, status, _, _ := accountBilling(t, d, id); has != 0 || status != "canceling" {
		t.Fatalf("scheduling the end must not turn backups back on: has=%d status=%s", has, status)
	}
}

func TestCancelingIgnoresInvoicePaidAndPaymentFailed(t *testing.T) {
	d := testDeps(t)
	id := cancelingAccount(t, d, "inv2@b.co", "sub_c2")
	sendWebhook(t, d, `{"id":"evt_c2","object":"event","type":"invoice.paid","data":{"object":{"id":"in_c2","object":"invoice","parent":{"type":"subscription_details","subscription_details":{"subscription":"sub_c2"}}}}}`)
	if has, status, _, _ := accountBilling(t, d, id); has != 0 || status != "canceling" {
		t.Fatalf("invoice.paid must not unlock a canceling account: has=%d status=%s", has, status)
	}
	sendWebhook(t, d, `{"id":"evt_c3","object":"event","type":"invoice.payment_failed","data":{"object":{"id":"in_c3","object":"invoice","parent":{"type":"subscription_details","subscription_details":{"subscription":"sub_c2"}}}}}`)
	if _, status, _, purge := accountBilling(t, d, id); status != "canceling" || purge != 0 {
		t.Fatalf("a failed final charge must not start a countdown for deleted copies: status=%s purge=%d", status, purge)
	}
}

func TestCancelingEndsCleanlyAndClearsBilledUsage(t *testing.T) {
	d := testDeps(t)
	id := cancelingAccount(t, d, "end@b.co", "sub_c4")
	period := billing.PeriodKeyUTC(time.Now())
	_, _ = d.DB.Exec(`INSERT INTO billing_storage_samples (account_id, period_ym, sampled_at, stored_bytes) VALUES (?, ?, ?, ?)`, id, period, time.Now().Unix()-3600, int64(2_000_000_000_000))
	_, _ = d.DB.Exec(`INSERT INTO billing_period_egress (account_id, period_ym, egress_bytes) VALUES (?, ?, ?)`, id, period, int64(5_000_000_000))
	sendWebhook(t, d, `{"id":"evt_c4","object":"event","type":"customer.subscription.deleted","data":{"object":{"id":"sub_c4","object":"subscription","status":"canceled"}}}`)
	has, status, sub, purge := accountBilling(t, d, id)
	if has != 0 || status != "canceled" || sub != "" || purge != 0 {
		t.Fatalf("after the scheduled end: has=%d status=%s sub=%q purge=%d", has, status, sub, purge)
	}
	if avg, egress := billing.AccountPeriodUsage(d.DB, id); avg != 0 || egress != 0 {
		t.Fatalf("billed usage must be cleared so a new subscription this month starts at zero: avg=%d egress=%d", avg, egress)
	}
}

func TestLinkCancelStillStartsTheCountdown(t *testing.T) {
	d := testDeps(t)
	id := checkoutAccount(t, d, "link@b.co")
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active', stripe_subscription_id = 'sub_c5' WHERE id = ?`, id)
	sendWebhook(t, d, `{"id":"evt_c5","object":"event","type":"customer.subscription.deleted","data":{"object":{"id":"sub_c5","object":"subscription","status":"canceled"}}}`)
	if _, status, sub, purge := accountBilling(t, d, id); status != "canceled" || sub != "" || purge == 0 {
		t.Fatalf("a cancel we didn't start (link.com) keeps the 30-day countdown: status=%s sub=%q purge=%d", status, sub, purge)
	}
}

func TestNoNewSubscriptionWhilePaymentIsBeingTurnedOff(t *testing.T) {
	devStripe(t)
	d := testDeps(t)
	id := cancelingAccount(t, d, "wait@b.co", "sub_c6")
	acct := Account{ID: id, Email: "wait@b.co", BillingStatus: "canceling", StripeSub: "sub_c6"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/checkout", strings.NewReader(`{"kind":"backup","return_to":"backups"}`))
	req = req.WithContext(WithAccount(req.Context(), acct))
	rec := httptest.NewRecorder()
	AccountHandler{Deps: d}.StartCheckout(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409 while the old subscription is still ending, got %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if msg, _ := body["error"].(string); !strings.Contains(msg, "being turned off") || strings.Contains(msg, "didn't go through") {
		t.Fatalf("message must say payment is being turned off: %q", msg)
	}
}
