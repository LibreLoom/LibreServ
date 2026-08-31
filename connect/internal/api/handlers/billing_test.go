package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	stripego "github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/webhook"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func signedStripeRequest(t *testing.T, eventType string, object any) *http.Request {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"id":      "evt_test",
		"object":  "event",
		"type":    eventType,
		"created": time.Now().Unix(),
		"data":    map[string]any{"object": object},
	})
	if err != nil {
		t.Fatal(err)
	}
	signed := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{
		Payload: payload,
		Secret:  config.C.Stripe.WebhookSecret,
	})
	req := httptest.NewRequest(http.MethodPost, "/webhooks/stripe", bytes.NewReader(payload))
	req.Header.Set("Stripe-Signature", signed.Header)
	return req
}

func callStripeWebhook(t *testing.T, h *BillingHandler, eventType string, object any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.StripeWebhook(w, signedStripeRequest(t, eventType, object))
	return w
}

func withStripeTestConfig(t *testing.T) {
	t.Helper()
	old := config.C.Stripe
	config.C.Stripe.Enabled = true
	config.C.Stripe.WebhookSecret = "whsec_test"
	config.C.Stripe.PriceFree = "price_free"
	config.C.Stripe.PriceLite = "price_lite"
	config.C.Stripe.PriceOne = "price_one"
	t.Cleanup(func() { config.C.Stripe = old })
}

func TestStripeWebhookValidationAndUnknownEvent(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewBillingHandler(billing.NewService(db))
	old := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = old })

	config.C.Stripe.Enabled = false
	w := httptest.NewRecorder()
	h.StripeWebhook(w, httptest.NewRequest(http.MethodPost, "/webhooks/stripe", strings.NewReader(`{}`)))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled webhook = %d", w.Code)
	}

	withStripeTestConfig(t)
	w = httptest.NewRecorder()
	h.StripeWebhook(w, httptest.NewRequest(http.MethodPost, "/webhooks/stripe", strings.NewReader(`{}`)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("unsigned webhook = %d", w.Code)
	}
	unknown := callStripeWebhook(t, h, "customer.created", map[string]any{"id": "cus_test"})
	if unknown.Code != http.StatusOK || !strings.Contains(unknown.Body.String(), "event received") {
		t.Fatalf("unknown webhook = %d: %s", unknown.Code, unknown.Body.String())
	}
}

func TestStripeSubscriptionWebhookLifecycle(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "free")
	accountID := accountForDevice(t, db, deviceID)
	withStripeTestConfig(t)
	h := NewBillingHandler(billing.NewService(db))

	subscription := map[string]any{
		"id":       "sub_stripe_test",
		"object":   "subscription",
		"status":   "active",
		"metadata": map[string]string{"device_id": deviceID},
		"items": map[string]any{
			"object": "list",
			"data": []any{map[string]any{
				"id":    "si_test",
				"object": "subscription_item",
				"price": map[string]any{"id": "price_lite", "object": "price"},
			}},
		},
	}
	created := callStripeWebhook(t, h, "customer.subscription.created", subscription)
	if created.Code != http.StatusOK {
		t.Fatalf("subscription created = %d: %s", created.Code, created.Body.String())
	}

	subscription["items"] = map[string]any{
		"object": "list",
		"data": []any{map[string]any{
			"id":    "si_test",
			"object": "subscription_item",
			"price": map[string]any{"id": "price_one", "object": "price"},
		}},
	}
	updated := callStripeWebhook(t, h, "customer.subscription.updated", subscription)
	if updated.Code != http.StatusOK {
		t.Fatalf("subscription updated = %d: %s", updated.Code, updated.Body.String())
	}
	var plan string
	if err := db.QueryRow(`SELECT plan_id FROM customer_accounts WHERE id = $1`, accountID).Scan(&plan); err != nil || plan != "one" {
		t.Fatalf("account plan = %q, %v", plan, err)
	}

	deleted := callStripeWebhook(t, h, "customer.subscription.deleted",
		map[string]any{"id": "sub_stripe_test", "object": "subscription"})
	if deleted.Code != http.StatusOK {
		t.Fatalf("subscription deleted = %d: %s", deleted.Code, deleted.Body.String())
	}
	if err := db.QueryRow(`SELECT plan_id FROM devices WHERE id = $1`, deviceID).Scan(&plan); err != nil || plan != "free" {
		t.Fatalf("device plan after delete = %q, %v", plan, err)
	}

	skipped := callStripeWebhook(t, h, "customer.subscription.created",
		map[string]any{"id": "sub_no_device", "object": "subscription", "metadata": map[string]string{}})
	if skipped.Code != http.StatusOK || !strings.Contains(skipped.Body.String(), "skipping") {
		t.Fatalf("subscription missing metadata = %d: %s", skipped.Code, skipped.Body.String())
	}
}

func TestStripeCheckoutAndInvoiceWebhooks(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "free")
	accountID := accountForDevice(t, db, deviceID)
	withStripeTestConfig(t)
	h := NewBillingHandler(billing.NewService(db))

	accountCheckout := map[string]any{
		"id":                  "cs_account",
		"object":              "checkout.session",
		"client_reference_id": accountID,
		"subscription": map[string]any{
			"id":     "sub_account",
			"object": "subscription",
			"items": map[string]any{
				"object": "list",
				"data": []any{map[string]any{
					"object": "subscription_item",
					"price":  map[string]any{"id": "price_lite", "object": "price"},
				}},
			},
		},
	}
	checkout := callStripeWebhook(t, h, "checkout.session.completed", accountCheckout)
	if checkout.Code != http.StatusOK {
		t.Fatalf("account checkout = %d: %s", checkout.Code, checkout.Body.String())
	}

	deviceCheckout := map[string]any{
		"id":                  "cs_device",
		"object":              "checkout.session",
		"client_reference_id": deviceID,
		"subscription": map[string]any{
			"id":     "sub_device_checkout",
			"object": "subscription",
			"items": map[string]any{
				"object": "list",
				"data": []any{map[string]any{
					"object": "subscription_item",
					"price":  map[string]any{"id": "price_one", "object": "price"},
				}},
			},
		},
	}
	checkout = callStripeWebhook(t, h, "checkout.session.completed", deviceCheckout)
	if checkout.Code != http.StatusOK {
		t.Fatalf("device checkout = %d: %s", checkout.Code, checkout.Body.String())
	}

	invoice := map[string]any{
		"id":       "in_paid",
		"object":   "invoice",
		"amount_paid": 2500,
		"metadata": map[string]string{"device_id": deviceID},
		"subscription": map[string]any{"id": "sub_device_checkout", "object": "subscription"},
	}
	paid := callStripeWebhook(t, h, "invoice.paid", invoice)
	if paid.Code != http.StatusOK {
		t.Fatalf("invoice paid = %d: %s", paid.Code, paid.Body.String())
	}
	failed := callStripeWebhook(t, h, "invoice.payment_failed",
		map[string]any{"id": "in_paid", "object": "invoice"})
	if failed.Code != http.StatusOK {
		t.Fatalf("invoice failed = %d: %s", failed.Code, failed.Body.String())
	}
	var status string
	if err := db.QueryRow(`SELECT status FROM invoices WHERE stripe_invoice_id = 'in_paid'`).Scan(&status); err != nil || status != "failed" {
		t.Fatalf("invoice status = %q, %v", status, err)
	}

	for _, object := range []map[string]any{
		{"id": "cs_empty", "object": "checkout.session"},
		{"id": "cs_missing", "object": "checkout.session", "client_reference_id": "missing"},
	} {
		got := callStripeWebhook(t, h, "checkout.session.completed", object)
		if got.Code != http.StatusOK {
			t.Fatalf("skipped checkout = %d: %s", got.Code, got.Body.String())
		}
	}
}

func TestBillingMappingHelpers(t *testing.T) {
	withStripeTestConfig(t)
	if got := priceToPlanFromSubscription(nil); got != "" {
		t.Fatalf("nil price mapping = %q", got)
	}
	for price, plan := range map[string]string{
		"price_free": "free",
		"price_lite": "lite",
		"price_one":  "one",
		"unknown":    "",
	} {
		sub := &stripego.Subscription{
			Items: &stripego.SubscriptionItemList{
				Data: []*stripego.SubscriptionItem{{Price: &stripego.Price{ID: price}}},
			},
		}
		if got := priceToPlanFromSubscription(sub); got != plan {
			t.Errorf("priceToPlan(%q) = %q", price, got)
		}
	}
	for plan, price := range map[string]string{
		"lite":    "price_lite",
		"one":     "price_one",
		"free":    "price_free",
		"missing": "price_free",
	} {
		if got := planToPrice(plan); got != price {
			t.Errorf("planToPrice(%q) = %q", plan, got)
		}
	}
}

func TestBillingHandlerInvalidPayloads(t *testing.T) {
	h := NewBillingHandler(billing.NewService(database.OpenTestDB(t)))
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	for name, fn := range map[string]func(http.ResponseWriter, *http.Request, json.RawMessage){
		"checkout":             h.handleCheckoutCompleted,
		"subscription created": h.handleSubscriptionCreated,
		"subscription updated": h.handleSubscriptionUpdated,
		"subscription deleted": h.handleSubscriptionDeleted,
		"invoice paid":         h.handleInvoicePaid,
		"invoice failed":       h.handleInvoiceFailed,
	} {
		w := httptest.NewRecorder()
		fn(w, req, json.RawMessage(`{`))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s invalid payload = %d", name, w.Code)
		}
	}
}
