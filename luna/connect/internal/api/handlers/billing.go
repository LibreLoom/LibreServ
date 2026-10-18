package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	stripego "github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/webhook"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

func (h AccountHandler) StripeWebhook(w http.ResponseWriter, r *http.Request) {
	providers.RefreshStripe()
	if !config.C.Stripe.Enabled {
		slog.Warn("stripe webhook rejected: billing disabled")
		JSONError(w, http.StatusServiceUnavailable, "Card billing is not set up on this Luna Connect site.")
		return
	}
	if !config.C.Stripe.WebhookReady() {
		// Permanent misconfig — 400 stops Stripe retry storms (503 would retry for days).
		slog.Error("stripe webhook rejected: webhook_secret missing; set whsec_… in Admin → Connections or stripe.webhook_secret in the config file")
		JSONError(w, http.StatusBadRequest, "Webhook signing secret is not set up on this Luna Connect site.")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, webhookLimit))
	if err != nil {
		JSONError(w, http.StatusBadRequest, "Could not read that billing update.")
		return
	}
	event, err := webhook.ConstructEventWithOptions(body, r.Header.Get("Stripe-Signature"),
		config.C.Stripe.WebhookSecret, webhook.ConstructEventOptions{
			Tolerance:                5 * time.Minute,
			IgnoreAPIVersionMismatch: true,
		})
	if err != nil {
		slog.Warn("stripe webhook verification failed", "error", err)
		JSONError(w, http.StatusForbidden, "Could not verify that billing update.")
		return
	}
	var handleErr error
	switch event.Type {
	case "customer.subscription.deleted":
		handleErr = h.cancelSubscription(event.Data.Raw)
	case "invoice.payment_failed":
		handleErr = h.lockFromInvoiceJSON(event.Data.Raw, "past_due")
	case "invoice.paid", "customer.subscription.updated":
		handleErr = h.unlockFromEvent(string(event.Type), event.Data.Raw)
	}
	if handleErr != nil {
		// A database failure is temporary: 500 makes Stripe retry the event.
		slog.Error("stripe webhook not applied; Stripe will retry", "event", event.ID, "type", event.Type, "error", handleErr)
		JSONError(w, http.StatusInternalServerError, "Could not save that billing update. It will be retried.")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "ok"})
}

// A canceled subscription no longer exists at Stripe. Clear the stored id so
// AttachCard (which treats any stored id as already-subscribed) can open a
// fresh subscription on the next card; billing_status stays for the record.
// A subscription no account owns (for example one we cancelled ourselves after
// losing a signup race) is not an error.
func (h AccountHandler) cancelSubscription(raw json.RawMessage) error {
	var sub stripego.Subscription
	if err := json.Unmarshal(raw, &sub); err != nil || sub.ID == "" {
		return nil
	}
	var accountID, email string
	if err := h.DB.QueryRow(`SELECT id, email FROM accounts WHERE stripe_subscription_id = ?`, sub.ID).Scan(&accountID, &email); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	if _, err := h.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = 'canceled', stripe_subscription_id = '', stripe_subscription_item_id = '' WHERE stripe_subscription_id = ?`, sub.ID); err != nil {
		return err
	}
	beginBackupPurgeForAccount(h.Deps, accountID, email)
	return nil
}

func (h AccountHandler) lockFromSubscriptionJSON(raw json.RawMessage, status string) error {
	var sub stripego.Subscription
	if err := json.Unmarshal(raw, &sub); err != nil || sub.ID == "" {
		return nil
	}
	return h.lockSubscription(sub.ID, status)
}

func (h AccountHandler) lockFromInvoiceJSON(raw json.RawMessage, status string) error {
	subID := subscriptionIDFromInvoiceJSON(raw)
	if subID == "" {
		return nil
	}
	return h.lockSubscription(subID, status)
}

func (h AccountHandler) lockSubscription(subID, status string) error {
	if _, err := h.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = ? WHERE stripe_subscription_id = ?`, status, subID); err != nil {
		return err
	}
	beginBackupPurgeForSubscription(h.Deps, subID)
	return nil
}

func (h AccountHandler) unlockFromEvent(kind string, raw json.RawMessage) error {
	subID, itemID, status := "", "", "active"
	switch kind {
	case "customer.subscription.updated":
		var sub stripego.Subscription
		if err := json.Unmarshal(raw, &sub); err != nil || sub.ID == "" {
			return nil
		}
		if sub.Status != stripego.SubscriptionStatusActive && sub.Status != stripego.SubscriptionStatusTrialing {
			return h.lockSubscription(sub.ID, string(sub.Status))
		}
		subID = sub.ID
		if sub.Items != nil && len(sub.Items.Data) > 0 && sub.Items.Data[0] != nil {
			itemID = sub.Items.Data[0].ID
		}
		status = string(sub.Status)
	default:
		subID = subscriptionIDFromInvoiceJSON(raw)
	}
	if subID == "" {
		return nil
	}
	if itemID != "" {
		_, err := h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = ?, stripe_subscription_item_id = ?, backup_purge_after = NULL, purge_mail_day = NULL WHERE stripe_subscription_id = ?`,
			status, itemID, subID)
		return err
	}
	_, err := h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = ?, backup_purge_after = NULL, purge_mail_day = NULL WHERE stripe_subscription_id = ?`, status, subID)
	return err
}

// subscriptionIDFromInvoiceJSON reads the subscription id from an invoice webhook
// payload. Pre-Basil APIs use top-level "subscription"; API 2025-03-31.basil+
// moved it to parent.subscription_details.subscription (string or expanded object).
// See https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects
func subscriptionIDFromInvoiceJSON(raw json.RawMessage) string {
	var inv struct {
		Subscription json.RawMessage `json:"subscription"`
		Parent       *struct {
			Type                string `json:"type"`
			SubscriptionDetails *struct {
				Subscription json.RawMessage `json:"subscription"`
			} `json:"subscription_details"`
		} `json:"parent"`
	}
	if err := json.Unmarshal(raw, &inv); err != nil {
		return ""
	}
	if id := stripeIDFromFlexibleJSON(inv.Subscription); id != "" {
		return id
	}
	if inv.Parent != nil && inv.Parent.SubscriptionDetails != nil &&
		(inv.Parent.Type == "" || inv.Parent.Type == "subscription_details") {
		return stripeIDFromFlexibleJSON(inv.Parent.SubscriptionDetails.Subscription)
	}
	return ""
}

func stripeIDFromFlexibleJSON(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString)
	}
	var asObj struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &asObj); err == nil {
		return strings.TrimSpace(asObj.ID)
	}
	return ""
}
