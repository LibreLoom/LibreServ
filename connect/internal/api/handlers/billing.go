package handlers

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers/polar"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// BillingHandler handles Polar webhook events.
type BillingHandler struct {
	billing *billing.Service
	db      interface {
		Exec(query string, args ...any) (any, error)
	}
}

// NewBillingHandler creates a billing handler.
func NewBillingHandler(b *billing.Service) *BillingHandler {
	return &BillingHandler{billing: b}
}

// PolarWebhook processes incoming Polar webhook events.
// Polar follows the Standard Webhooks spec: webhook-id, webhook-timestamp, webhook-signature headers.
func (h *BillingHandler) PolarWebhook(w http.ResponseWriter, r *http.Request) {
	if !config.C.Polar.Enabled {
		JSONError(w, http.StatusServiceUnavailable, "billing is not enabled")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "could not read request body")
		return
	}

	// Verify the webhook signature using the Standard Webhooks spec
	_, err = polar.VerifyWebhook(body, r.Header, config.C.Polar.WebhookSecret)
	if err != nil {
		slog.Warn("polar webhook verification failed", "error", err)
		JSONError(w, http.StatusForbidden, "webhook signature verification failed")
		return
	}

	// Parse the Standard Webhooks payload: {type, timestamp, data}
	var event struct {
		Type      string          `json:"type"`
		Timestamp string          `json:"timestamp"`
		Data      json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &event); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid webhook payload")
		return
	}

	slog.Info("polar webhook received", "type", event.Type)

	switch event.Type {
	case "subscription.created":
		h.handleSubscriptionCreated(w, r, event.Data)
	case "subscription.active":
		h.handleSubscriptionActive(w, r, event.Data)
	case "subscription.updated":
		h.handleSubscriptionUpdated(w, r, event.Data)
	case "subscription.canceled":
		h.handleSubscriptionCanceled(w, r, event.Data)
	case "subscription.revoked":
		h.handleSubscriptionRevoked(w, r, event.Data)
	case "subscription.uncanceled":
		h.handleSubscriptionUncanceled(w, r, event.Data)
	case "subscription.past_due":
		h.handleSubscriptionPastDue(w, r, event.Data)
	case "order.paid":
		h.handleOrderPaid(w, r, event.Data)
	default:
		JSON(w, http.StatusOK, map[string]string{"message": "event received"})
	}
}

// subscriptionPayload extracts the fields we need from Polar subscription events.
type subscriptionPayload struct {
	ID                 string `json:"id"`
	Status             string `json:"status"`
	CustomerID         string `json:"customer_id"`
	ProductID          string `json:"product_id"`
	CurrentPeriodStart string `json:"current_period_start"`
	CurrentPeriodEnd   string `json:"current_period_end"`
	CancelAtPeriodEnd  bool   `json:"cancel_at_period_end"`
}

// handleSubscriptionCreated records a new subscription in our DB.
// The external_customer_id we passed during checkout links Polar's customer to our device.
func (h *BillingHandler) handleSubscriptionCreated(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub subscriptionPayload
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	// The external_customer_id is our device ID
	deviceID := sub.CustomerID
	planID := productToPlan(sub.ProductID)

	_, err := h.billing.DB().Exec(
		`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at, polar_subscription_id)
		 VALUES ($1, $2, $3, 'active', $4, $5)
		 ON CONFLICT (device_id) DO UPDATE SET
		   plan_id = excluded.plan_id,
		   status = 'active',
		   polar_subscription_id = excluded.polar_subscription_id,
		   started_at = excluded.started_at`,
		security.GenerateID("sub"), deviceID, planID, time.Now(), sub.ID)
	if err != nil {
		slog.Error("failed to record subscription", "error", err, "device", deviceID)
		JSONError(w, http.StatusInternalServerError, "could not record subscription")
		return
	}

	_, _ = h.billing.DB().Exec(
		"UPDATE devices SET plan_id = $1 WHERE id = $2", planID, deviceID)

	JSON(w, http.StatusOK, map[string]string{"message": "subscription created"})
}

// handleSubscriptionActive activates a subscription.
func (h *BillingHandler) handleSubscriptionActive(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub subscriptionPayload
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	_, err := h.billing.DB().Exec(
		`UPDATE subscriptions SET status = 'active' WHERE polar_subscription_id = $1`, sub.ID)
	if err != nil {
		slog.Error("failed to activate subscription", "error", err, "polar_sub", sub.ID)
	}
	JSON(w, http.StatusOK, map[string]string{"message": "subscription activated"})
}

// handleSubscriptionUpdated handles plan changes and status updates.
func (h *BillingHandler) handleSubscriptionUpdated(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub subscriptionPayload
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	planID := productToPlan(sub.ProductID)
	_, err := h.billing.DB().Exec(
		`UPDATE subscriptions SET status = $1, plan_id = $2 WHERE polar_subscription_id = $3`,
		sub.Status, planID, sub.ID)
	if err != nil {
		slog.Error("failed to update subscription", "error", err, "polar_sub", sub.ID)
	}

	// Update device plan
	if planID != "" {
		_, _ = h.billing.DB().Exec(
			`UPDATE devices SET plan_id = $1 WHERE id = (
				SELECT device_id FROM subscriptions WHERE polar_subscription_id = $2
			)`, planID, sub.ID)
	}

	JSON(w, http.StatusOK, map[string]string{"message": "subscription updated"})
}

// handleSubscriptionCanceled marks a subscription as cancelled (may still be active until period end).
func (h *BillingHandler) handleSubscriptionCanceled(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub subscriptionPayload
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	_, err := h.billing.DB().Exec(
		`UPDATE subscriptions SET status = 'cancelled', ends_at = $1 WHERE polar_subscription_id = $2`,
		sub.CurrentPeriodEnd, sub.ID)
	if err != nil {
		slog.Error("failed to cancel subscription", "error", err, "polar_sub", sub.ID)
	}
	JSON(w, http.StatusOK, map[string]string{"message": "subscription cancelled"})
}

// handleSubscriptionRevoked fully ends a subscription — downgrade to free.
func (h *BillingHandler) handleSubscriptionRevoked(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub subscriptionPayload
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	_, err := h.billing.DB().Exec(
		`UPDATE subscriptions SET status = 'revoked', ends_at = $1 WHERE polar_subscription_id = $2`,
		time.Now(), sub.ID)
	if err != nil {
		slog.Error("failed to revoke subscription", "error", err, "polar_sub", sub.ID)
	}

	// Downgrade device to free plan
	_, _ = h.billing.DB().Exec(
		`UPDATE devices SET plan_id = 'free' WHERE id = (
			SELECT device_id FROM subscriptions WHERE polar_subscription_id = $1
		)`, sub.ID)

	JSON(w, http.StatusOK, map[string]string{"message": "subscription revoked"})
}

// handleSubscriptionUncanceled reactivates a cancelled subscription.
func (h *BillingHandler) handleSubscriptionUncanceled(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub subscriptionPayload
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	_, err := h.billing.DB().Exec(
		`UPDATE subscriptions SET status = 'active', ends_at = NULL WHERE polar_subscription_id = $1`, sub.ID)
	if err != nil {
		slog.Error("failed to uncancel subscription", "error", err, "polar_sub", sub.ID)
	}
	JSON(w, http.StatusOK, map[string]string{"message": "subscription uncanceled"})
}

// handleSubscriptionPastDue marks a subscription as past_due (payment failed).
func (h *BillingHandler) handleSubscriptionPastDue(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub subscriptionPayload
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	_, err := h.billing.DB().Exec(
		`UPDATE subscriptions SET status = 'past_due' WHERE polar_subscription_id = $1`, sub.ID)
	if err != nil {
		slog.Error("failed to mark subscription past_due", "error", err, "polar_sub", sub.ID)
	}
	JSON(w, http.StatusOK, map[string]string{"message": "subscription past due"})
}

// orderPayload extracts fields from Polar order events.
type orderPayload struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	Amount     int    `json:"amount"`
	CustomerID string `json:"customer_id"`
	ProductID  string `json:"product_id"`
}

// handleOrderPaid records a paid order as an invoice.
func (h *BillingHandler) handleOrderPaid(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var order orderPayload
	if err := json.Unmarshal(data, &order); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid order data")
		return
	}

	deviceID := order.CustomerID
	now := time.Now()

	// Record the invoice
	_, err := h.billing.DB().Exec(
		`INSERT INTO invoices (id, device_id, polar_invoice_id, status, amount_cents, period_start, period_end, paid_at)
		 VALUES ($1, $2, $3, 'paid', $4, $5, $6, $7)
		 ON CONFLICT DO NOTHING`,
		security.GenerateID("inv"), deviceID, order.ID, order.Amount, now, now.AddDate(0, 1, 0), now)
	if err != nil {
		slog.Error("failed to record invoice", "error", err, "device", deviceID)
	}

	JSON(w, http.StatusOK, map[string]string{"message": "order paid"})
}

// productToPlan maps a Polar product ID to our internal plan ID.
func productToPlan(productID string) string {
	if productID == config.C.Polar.ProductLite {
		return "lite"
	}
	if productID == config.C.Polar.ProductOne {
		return "one"
	}
	if productID == config.C.Polar.ProductFree {
		return "free"
	}
	return ""
}

// planToProduct maps our internal plan ID to a Polar product ID.
func planToProduct(planID string) string {
	switch planID {
	case "lite":
		return config.C.Polar.ProductLite
	case "one":
		return config.C.Polar.ProductOne
	default:
		return config.C.Polar.ProductFree
	}
}

// unused but keeps catalog import for future use
var _ = catalog.PlanByID
