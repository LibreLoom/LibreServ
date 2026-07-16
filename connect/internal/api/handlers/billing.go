package handlers

import (
	"encoding/json"
	"io"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
)

// BillingHandler handles Stripe webhook events.
type BillingHandler struct {
	billing *billing.Service
}

func NewBillingHandler(b *billing.Service) *BillingHandler {
	return &BillingHandler{billing: b}
}

// StripeWebhook processes incoming Stripe webhook events.
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

	// In production, verify the Stripe signature here using config.C.Stripe.WebhookSecret.
	// For now, parse the event and handle known types.
	var event struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &event); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid webhook payload")
		return
	}

	switch event.Type {
	case "invoice.paid":
		h.handleInvoicePaid(w, r, event.Data)
	case "invoice.payment_failed":
		h.handleInvoiceFailed(w, r, event.Data)
	case "customer.subscription.deleted":
		h.handleSubscriptionDeleted(w, r, event.Data)
	case "customer.subscription.updated":
		h.handleSubscriptionUpdated(w, r, event.Data)
	default:
		// Acknowledge unknown events
		JSON(w, http.StatusOK, map[string]string{"message": "event received"})
	}
}

func (h *BillingHandler) handleInvoicePaid(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var invoice struct {
		ID       string `json:"id"`
		Customer string `json:"customer"`
		Amount   int    `json:"amount_paid"`
	}
	if err := json.Unmarshal(data, &invoice); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid invoice data")
		return
	}

	// Mark matching invoice as paid (lookup by stripe_invoice_id)
	// In production, look up device_id from Stripe customer ID
	_ = invoice
	JSON(w, http.StatusOK, map[string]string{"message": "invoice paid"})
}

func (h *BillingHandler) handleInvoiceFailed(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	JSON(w, http.StatusOK, map[string]string{"message": "invoice failure noted"})
}

func (h *BillingHandler) handleSubscriptionDeleted(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	JSON(w, http.StatusOK, map[string]string{"message": "subscription deleted"})
}

func (h *BillingHandler) handleSubscriptionUpdated(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	JSON(w, http.StatusOK, map[string]string{"message": "subscription updated"})
}
