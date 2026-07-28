package handlers

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	stripego "github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/webhook"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// BillingHandler handles Stripe webhook events.
type BillingHandler struct {
	billing *billing.Service
}

// NewBillingHandler creates a billing handler.
func NewBillingHandler(b *billing.Service) *BillingHandler {
	return &BillingHandler{billing: b}
}

// StripeWebhook processes incoming Stripe webhook events.
// Uses the Stripe SDK's built-in signature verification (tolerance 5 minutes).
func (h *BillingHandler) StripeWebhook(w http.ResponseWriter, r *http.Request) {
	if !config.C.Stripe.Enabled {
		JSONError(w, http.StatusServiceUnavailable, "billing is not enabled")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "could not read request body")
		return
	}

	// Verify the webhook signature using the Stripe SDK
	event, err := webhook.ConstructEventWithOptions(body, r.Header.Get("Stripe-Signature"),
		config.C.Stripe.WebhookSecret, webhook.ConstructEventOptions{
			Tolerance: 5 * time.Minute,
		})
	if err != nil {
		slog.Warn("stripe webhook verification failed", "error", err)
		JSONError(w, http.StatusForbidden, "webhook signature verification failed")
		return
	}

	slog.Info("stripe webhook received", "type", event.Type)

	switch event.Type {
	case "checkout.session.completed":
		h.handleCheckoutCompleted(w, r, event.Data.Raw)
	case "customer.subscription.created":
		h.handleSubscriptionCreated(w, r, event.Data.Raw)
	case "customer.subscription.updated":
		h.handleSubscriptionUpdated(w, r, event.Data.Raw)
	case "customer.subscription.deleted":
		h.handleSubscriptionDeleted(w, r, event.Data.Raw)
	case "invoice.paid":
		h.handleInvoicePaid(w, r, event.Data.Raw)
	case "invoice.payment_failed":
		h.handleInvoiceFailed(w, r, event.Data.Raw)
	default:
		JSON(w, http.StatusOK, map[string]string{"message": "event received"})
	}
}

// handleCheckoutCompleted records the subscription when checkout succeeds.
// The client_reference_id is our device ID, set during checkout session creation.
func (h *BillingHandler) handleCheckoutCompleted(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var session stripego.CheckoutSession
	if err := json.Unmarshal(data, &session); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid checkout session data")
		return
	}

	deviceID := session.ClientReferenceID
	if deviceID == "" {
		JSON(w, http.StatusOK, map[string]string{"message": "no client reference, skipping"})
		return
	}

	// Determine plan from the subscription's price items
	planID := "free"
	if session.Subscription != nil {
		planID = priceToPlanFromSubscription(session.Subscription)
	}

	_, err := h.billing.DB().Exec(
		`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at, stripe_subscription_id)
		 VALUES ($1, $2, $3, 'active', $4, $5)
		 ON CONFLICT (device_id) DO UPDATE SET
		   plan_id = excluded.plan_id,
		   status = 'active',
		   stripe_subscription_id = excluded.stripe_subscription_id,
		   started_at = excluded.started_at`,
		security.GenerateID("sub"), deviceID, planID, time.Now(), session.Subscription.ID)
	if err != nil {
		slog.Error("failed to record subscription from checkout", "error", err, "device", deviceID)
		JSONError(w, http.StatusInternalServerError, "could not record subscription")
		return
	}

	_, _ = h.billing.DB().Exec(
		"UPDATE devices SET plan_id = $1 WHERE id = $2", planID, deviceID)

	JSON(w, http.StatusOK, map[string]string{"message": "checkout completed"})
}

// handleSubscriptionCreated records a new subscription.
func (h *BillingHandler) handleSubscriptionCreated(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub stripego.Subscription
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	deviceID := sub.Metadata["device_id"]
	planID := priceToPlanFromSubscription(&sub)

	_, err := h.billing.DB().Exec(
		`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at, stripe_subscription_id)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (device_id) DO UPDATE SET
		   plan_id = excluded.plan_id,
		   status = excluded.status,
		   stripe_subscription_id = excluded.stripe_subscription_id,
		   started_at = excluded.started_at`,
		security.GenerateID("sub"), deviceID, planID, string(sub.Status), time.Now(), sub.ID)
	if err != nil {
		slog.Error("failed to record subscription", "error", err, "device", deviceID)
		JSONError(w, http.StatusInternalServerError, "could not record subscription")
		return
	}

	_, _ = h.billing.DB().Exec(
		"UPDATE devices SET plan_id = $1 WHERE id = $2", planID, deviceID)

	JSON(w, http.StatusOK, map[string]string{"message": "subscription created"})
}

// handleSubscriptionUpdated handles plan changes and status updates.
func (h *BillingHandler) handleSubscriptionUpdated(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub stripego.Subscription
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	planID := priceToPlanFromSubscription(&sub)
	_, err := h.billing.DB().Exec(
		`UPDATE subscriptions SET status = $1, plan_id = $2 WHERE stripe_subscription_id = $3`,
		string(sub.Status), planID, sub.ID)
	if err != nil {
		slog.Error("failed to update subscription", "error", err, "stripe_sub", sub.ID)
	}

	if planID != "" {
		_, _ = h.billing.DB().Exec(
			`UPDATE devices SET plan_id = $1 WHERE id = (
				SELECT device_id FROM subscriptions WHERE stripe_subscription_id = $2
			)`, planID, sub.ID)
	}

	JSON(w, http.StatusOK, map[string]string{"message": "subscription updated"})
}

// handleSubscriptionDeleted revokes the subscription — downgrade to free.
func (h *BillingHandler) handleSubscriptionDeleted(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub stripego.Subscription
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	_, err := h.billing.DB().Exec(
		`UPDATE subscriptions SET status = 'revoked', ends_at = $1 WHERE stripe_subscription_id = $2`,
		time.Now(), sub.ID)
	if err != nil {
		slog.Error("failed to revoke subscription", "error", err, "stripe_sub", sub.ID)
	}

	_, _ = h.billing.DB().Exec(
		`UPDATE devices SET plan_id = 'free' WHERE id = (
			SELECT device_id FROM subscriptions WHERE stripe_subscription_id = $1
		)`, sub.ID)

	JSON(w, http.StatusOK, map[string]string{"message": "subscription deleted"})
}

// handleInvoicePaid records a paid invoice.
func (h *BillingHandler) handleInvoicePaid(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var invoice stripego.Invoice
	if err := json.Unmarshal(data, &invoice); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid invoice data")
		return
	}

	deviceID := invoice.Metadata["device_id"]
	if deviceID == "" {
		// Try to look up device from subscription
		_ = h.billing.DB().QueryRow(
			"SELECT device_id FROM subscriptions WHERE stripe_subscription_id = $1",
			invoice.Subscription,
		).Scan(&deviceID)
	}

	if deviceID == "" {
		JSON(w, http.StatusOK, map[string]string{"message": "no device linked, skipping invoice"})
		return
	}

	now := time.Now()
	_, err := h.billing.DB().Exec(
		`INSERT INTO invoices (id, device_id, stripe_invoice_id, status, amount_cents, period_start, period_end, paid_at)
		 VALUES ($1, $2, $3, 'paid', $4, $5, $6, $7)
		 ON CONFLICT DO NOTHING`,
		security.GenerateID("inv"), deviceID, invoice.ID, invoice.AmountPaid, now, now.AddDate(0, 1, 0), now)
	if err != nil {
		slog.Error("failed to record invoice", "error", err, "device", deviceID)
	}

	JSON(w, http.StatusOK, map[string]string{"message": "invoice paid"})
}

// handleInvoiceFailed notes a failed payment.
func (h *BillingHandler) handleInvoiceFailed(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var invoice stripego.Invoice
	if err := json.Unmarshal(data, &invoice); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid invoice data")
		return
	}

	_, err := h.billing.DB().Exec(
		`UPDATE invoices SET status = 'failed' WHERE stripe_invoice_id = $1`, invoice.ID)
	if err != nil {
		slog.Error("failed to mark invoice failed", "error", err, "stripe_invoice", invoice.ID)
	}

	JSON(w, http.StatusOK, map[string]string{"message": "invoice payment failed"})
}

// priceToPlan maps a Stripe price ID to our internal plan ID.
// We use the subscription's items to find the price.
func priceToPlan(_ int64) string {
	// This is a fallback — the real mapping happens in priceToPlanFromSubscription
	return "free"
}

// priceToPlanFromSubscription extracts the plan ID from a subscription's price items.
func priceToPlanFromSubscription(sub *stripego.Subscription) string {
	if sub == nil || len(sub.Items.Data) == 0 {
		return ""
	}
	for _, item := range sub.Items.Data {
		priceID := item.Price.ID
		if priceID == config.C.Stripe.PriceLite {
			return "lite"
		}
		if priceID == config.C.Stripe.PriceOne {
			return "one"
		}
		if priceID == config.C.Stripe.PriceFree {
			return "free"
		}
	}
	return ""
}

// planToPrice maps our internal plan ID to a Stripe price ID.
func planToPrice(planID string) string {
	switch planID {
	case "lite":
		return config.C.Stripe.PriceLite
	case "one":
		return config.C.Stripe.PriceOne
	default:
		return config.C.Stripe.PriceFree
	}
}

// unused but keeps catalog import for future use
var _ = catalog.PlanByID
