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

	stripego "github.com/stripe/stripe-go/v87"
	"github.com/stripe/stripe-go/v87/webhook"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
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
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		// The return page usually got here first; fulfillCheckout is idempotent.
		var c billing.Checkout
		if c, handleErr = billing.CheckoutFromEvent(event.Data.Raw); handleErr == nil {
			handleErr = fulfillCheckout(h.Deps, c)
		}
	case "customer.subscription.deleted":
		handleErr = h.cancelSubscription(event.Data.Raw)
	case "invoice.payment_failed", "invoice.payment_action_required":
		// action_required: the bank wants the customer to confirm the charge
		// (common for EU cards). Both leave the bill unpaid; the warning mail
		// links the bill's Stripe page, where either is fixed.
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
// StartCheckout (which treats any stored id as already-subscribed) can open a
// fresh subscription; billing_status stays for the record.
// A subscription no account owns (for example one we cancelled ourselves after
// losing a signup race) is not an error.
func (h AccountHandler) cancelSubscription(raw json.RawMessage) error {
	var sub stripego.Subscription
	if err := json.Unmarshal(raw, &sub); err != nil || sub.ID == "" {
		return nil
	}
	var accountID, email, status string
	if err := h.DB.QueryRow(`SELECT id, email, COALESCE(billing_status, '') FROM accounts WHERE stripe_subscription_id = ?`, sub.ID).Scan(&accountID, &email, &status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	if status == "canceling" {
		// The end "Turn off payment" scheduled: copies are already gone.
		return finishCanceling(h.Deps, accountID, sub.ID)
	}
	if _, err := h.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = 'canceled', stripe_subscription_id = '' WHERE stripe_subscription_id = ?`, sub.ID); err != nil {
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

// lockSubscription turns backups off after a failed or stalled payment and
// starts the 30-day countdown. An account whose payment is being turned off
// ("canceling") is left alone: its copies are already deleted.
func (h AccountHandler) lockSubscription(subID, status string) error {
	res, err := h.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = ? WHERE stripe_subscription_id = ? AND COALESCE(billing_status, '') != 'canceling'`, status, subID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil
	}
	beginBackupPurgeForSubscription(h.Deps, subID)
	return nil
}

// finishCanceling runs once a subscription that "Turn off payment" scheduled
// to end has ended: it unlinks the account, charges the final invoice now
// instead of in Stripe's hour, and clears this month's usage samples, which
// that invoice billed, so a new subscription starts from zero.
func finishCanceling(deps Deps, accountID, subID string) error {
	if _, err := deps.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = 'canceled', stripe_subscription_id = '' WHERE id = ? AND stripe_subscription_id = ?`, accountID, subID); err != nil {
		return err
	}
	period := billing.PeriodKeyUTC(time.Now())
	if _, err := deps.DB.Exec(`DELETE FROM billing_storage_samples WHERE account_id = ? AND period_ym = ?`, accountID, period); err != nil {
		slog.Error("could not clear billed usage samples; a new subscription this month would bill them again", "account", accountID, "error", err)
	}
	if _, err := deps.DB.Exec(`DELETE FROM billing_period_egress WHERE account_id = ? AND period_ym = ?`, accountID, period); err != nil {
		slog.Error("could not clear billed egress; a new subscription this month would bill it again", "account", accountID, "error", err)
	}
	if err := billing.SettleFinalInvoice(subID); err != nil {
		slog.Error("could not charge the final cloud backup invoice; Stripe finalizes it within the hour", "account", accountID, "subscription", subID, "error", err)
	}
	return nil
}

func (h AccountHandler) unlockFromEvent(kind string, raw json.RawMessage) error {
	subID, status := "", "active"
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
		status = string(sub.Status)
	default:
		subID = subscriptionIDFromInvoiceJSON(raw)
	}
	if subID == "" {
		return nil
	}
	// "canceling": payment is being turned off. Scheduling the end fires
	// customer.subscription.updated while it is still active, and that must
	// not turn backups back on.
	_, err := h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = ?, backup_purge_after = NULL, purge_mail_day = NULL WHERE stripe_subscription_id = ? AND COALESCE(billing_status, '') != 'canceling'`, status, subID)
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
