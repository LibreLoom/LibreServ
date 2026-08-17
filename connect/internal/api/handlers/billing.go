package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	stripego "github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/webhook"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/services"
)

// BillingHandler handles Stripe webhook events.
type BillingHandler struct {
	billing   *billing.Service
	registrar *providers.RegistrarClient
}

// NewBillingHandler creates a billing handler.
func NewBillingHandler(b *billing.Service) *BillingHandler {
	return &BillingHandler{billing: b, registrar: providers.NewRegistrarClient(nil)}
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
			Tolerance:                5 * time.Minute,
			IgnoreAPIVersionMismatch: true,
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
// The client_reference_id is set during checkout session creation — it can be
// either a device ID (if a device exists) or an account ID (during onboarding,
// before the device is activated). We detect which it is and update the plan
// accordingly.
func (h *BillingHandler) handleCheckoutCompleted(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var session stripego.CheckoutSession
	if err := json.Unmarshal(data, &session); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid checkout session data")
		return
	}

	refID := session.ClientReferenceID
	if refID == "" {
		JSON(w, http.StatusOK, map[string]string{"message": "no client reference, skipping"})
		return
	}

	// Check if this is a domain registration payment (metadata.type = domain_registration)
	if session.Metadata != nil && session.Metadata["type"] == "domain_registration" {
		h.handleDomainPurchase(w, r, &session)
		return
	}

	// Determine plan from the subscription's price items. The webhook event
	// may contain an unexpanded subscription (just the ID, no items), so we
	// retrieve the full subscription from the Stripe API when needed.
	planID := "free"
	if session.Subscription != nil && session.Subscription.ID != "" {
		planID = priceToPlanFromSubscription(session.Subscription)
		if planID == "" {
			// Items not populated in the webhook event — fetch the full subscription.
			fullSub, err := providers.GetSubscription(r.Context(), session.Subscription.ID)
			if err != nil {
				slog.Warn("could not retrieve subscription for plan lookup", "sub", session.Subscription.ID, "error", err)
			} else {
				planID = priceToPlanFromSubscription(fullSub)
			}
		}
	}
	if planID == "" {
		planID = "free"
	}

	// Check whether refID is a device ID or an account ID
	var deviceID string
	var accountID string
	err := h.billing.DB().QueryRow(
		"SELECT id, account_id FROM devices WHERE id = $1", refID).Scan(&deviceID, &accountID)
	if err == sql.ErrNoRows {
		// Not a device — check if it's an account ID
		err = h.billing.DB().QueryRow(
			"SELECT id FROM customer_accounts WHERE id = $1", refID).Scan(&accountID)
		if err != nil {
			slog.Warn("checkout completed but client_reference_id not found", "ref", refID)
			JSON(w, http.StatusOK, map[string]string{"message": "ref not found, skipping"})
			return
		}
		// It's an account ID — update the account's plan directly
		_, _ = h.billing.DB().Exec(
			`UPDATE customer_accounts SET plan_id = $1, updated_at = $2 WHERE id = $3`,
			planID, time.Now(), accountID)
		slog.Info("checkout completed: updated account plan", "account", accountID, "plan", planID)
		JSON(w, http.StatusOK, map[string]string{"message": "checkout completed"})
		return
	}
	if err != nil {
		slog.Error("failed to look up device from checkout", "error", err, "ref", refID)
		JSONError(w, http.StatusInternalServerError, "could not record subscription")
		return
	}

	// It's a device ID — record the subscription and update both device + account
	_, err = h.billing.DB().Exec(
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

	h.updateDevicePlan(deviceID, planID)

	JSON(w, http.StatusOK, map[string]string{"message": "checkout completed"})
}

// handleDomainPurchase registers a domain after the Stripe payment succeeds.
// Called from handleCheckoutCompleted when metadata.type == "domain_registration".
func (h *BillingHandler) handleDomainPurchase(w http.ResponseWriter, r *http.Request, session *stripego.CheckoutSession) {
	domainName := session.Metadata["domain"]
	deviceID := session.Metadata["device_id"]
	accountID := session.Metadata["account_id"]
	if domainName == "" {
		slog.Error("domain purchase missing metadata", "metadata", session.Metadata)
		JSONError(w, http.StatusBadRequest, "missing domain metadata")
		return
	}

	// If no account_id in metadata, derive it from the device.
	if accountID == "" && deviceID != "" {
		_ = h.billing.DB().QueryRow(
			"SELECT account_id FROM devices WHERE id = $1", deviceID).Scan(&accountID)
	}
	if accountID == "" {
		slog.Error("domain purchase: no account_id", "device", deviceID)
		JSONError(w, http.StatusBadRequest, "missing account information")
		return
	}

	// Look up the Cloudflare API credentials from the tunnel service provider
	var credentialsJSON, settingsJSON string
	err := h.billing.DB().QueryRow(
		`SELECT credentials_json, settings_json FROM service_providers WHERE service = 'tunnel' AND enabled = TRUE LIMIT 1`,
	).Scan(&credentialsJSON, &settingsJSON)
	if err != nil {
		slog.Error("no tunnel provider configured for domain registration", "error", err)
		JSONError(w, http.StatusBadGateway, "Cloudflare provider not configured")
		return
	}

	var creds map[string]any
	json.Unmarshal([]byte(credentialsJSON), &creds)
	var settings map[string]any
	json.Unmarshal([]byte(settingsJSON), &settings)

	apiToken, _ := creds["api_token"].(string)
	cfAccountID, _ := settings["account_id"].(string)

	// Check domain availability and get the at-cost renewal price before registering.
	// This is the price the user pays at each annual renewal — refreshed by the scheduler.
	domainInfo, checkErr := h.registrar.CheckDomain(cfAccountID, apiToken, domainName)
	var renewalCostCents int64
	if checkErr == nil && domainInfo != nil {
		renewalCostCents, _ = parseDomainCostToCents(domainInfo.RenewalCost)
	}

	// Register the domain via Cloudflare Registrar (auto_renew=true is set by the client).
	expiresAt, err := h.registrar.RegisterDomain(cfAccountID, apiToken, domainName)
	if err != nil {
		slog.Error("failed to register domain after payment", "error", err, "domain", domainName)
		JSONError(w, http.StatusBadGateway, "could not register domain")
		return
	}

	// If registration is async (pending) and no expiry was returned, estimate now + 365 days.
	// The scheduler corrects this on its next sync via GetDomain.
	if expiresAt.IsZero() {
		expiresAt = time.Now().AddDate(1, 0, 0)
	}

	// Record the domain purchase in custom_domains with expiry and renewal cost.
	// Cloudflare auto-renews (charged to the CF account); LibreServ recovers the
	// cost by deducting from the device's account credit on each renewal (scheduler).
	amountCents := session.AmountTotal
	_, err = h.billing.DB().Exec(
		`INSERT INTO custom_domains (id, device_id, account_id, domain, registered_via, registration_cost_cents, renewal_cost_cents, auto_renew, status, expires_at)
		 VALUES ($1, $2, $3, $4, 'cloudflare', $5, $6, TRUE, 'active', $7)
		 ON CONFLICT (domain) DO UPDATE SET
		   device_id = EXCLUDED.device_id,
		   account_id = EXCLUDED.account_id,
		   status = 'active',
		   expires_at = EXCLUDED.expires_at,
		   renewal_cost_cents = EXCLUDED.renewal_cost_cents,
		   auto_renew = TRUE`,
		security.GenerateID("dom"), deviceID, accountID, domainName, int(amountCents), int(renewalCostCents), expiresAt)
	if err != nil {
		// The payment succeeded but the domain was never recorded — surface
		// the failure so Stripe retries the webhook instead of leaving a
		// paid-for domain that silently doesn't exist.
		slog.Error("failed to record domain purchase", "error", err, "domain", domainName)
		JSONError(w, http.StatusInternalServerError, "could not record the purchased domain")
		return
	}

	// If a device is linked, cancel the old domain and let the single
	// reconciler take over: DNS CNAME → tunnel, tunnel ingress, and the
	// device's domain credential are all re-applied for the new domain.
	if deviceID != "" {
		h.cancelOldDomain(deviceID, apiToken, cfAccountID)
		services.NewDomainCoordinator(h.billing.DB()).Reconcile(deviceID)
	}

	slog.Info("domain registered after payment", "domain", domainName, "device", deviceID, "account", accountID, "cost_cents", amountCents, "renewal_cents", renewalCostCents, "expires_at", expiresAt)
	JSON(w, http.StatusOK, map[string]string{"message": "domain registered"})
}

// handleSubscriptionCreated records a new subscription.
func (h *BillingHandler) handleSubscriptionCreated(w http.ResponseWriter, r *http.Request, data json.RawMessage) {
	var sub stripego.Subscription
	if err := json.Unmarshal(data, &sub); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid subscription data")
		return
	}

	deviceID := sub.Metadata["device_id"]
	if deviceID == "" {
		// No device_id in metadata — handleCheckoutCompleted will record
		// this subscription using the checkout session's ClientReferenceID.
		JSON(w, http.StatusOK, map[string]string{"message": "no device_id in metadata, skipping"})
		return
	}

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

	h.updateDevicePlan(deviceID, planID)

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
		var devID string
		_ = h.billing.DB().QueryRow(
			"SELECT device_id FROM subscriptions WHERE stripe_subscription_id = $1", sub.ID).Scan(&devID)
		if devID != "" {
			h.updateDevicePlan(devID, planID)
		}
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

	var devID string
	_ = h.billing.DB().QueryRow(
		"SELECT device_id FROM subscriptions WHERE stripe_subscription_id = $1", sub.ID).Scan(&devID)
	if devID != "" {
		h.updateDevicePlan(devID, "free")
		// Put any active custom domain into grace on downgrade to Free.
		h.handleDomainGraceOnDowngrade(r.Context(), devID)
	}

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
		// Try to look up device from subscription by stripe_subscription_id
		_ = h.billing.DB().QueryRow(
			"SELECT device_id FROM subscriptions WHERE stripe_subscription_id = $1",
			invoice.Subscription.ID,
		).Scan(&deviceID)
	}

	// Fallback: when the subscription row has a stale or missing stripe_subscription_id
	// (e.g., after cancel→re-subscribe), look up via the invoice's customer email.
	if deviceID == "" && invoice.CustomerEmail != "" {
		var accountID string
		if h.billing.DB().QueryRow(
			"SELECT id FROM customer_accounts WHERE email = $1",
			invoice.CustomerEmail).Scan(&accountID) == nil && accountID != "" {
			_ = h.billing.DB().QueryRow(
				"SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE LIMIT 1",
				accountID).Scan(&deviceID)
		}
	}

	// Update stale subscription row so future lookups by stripe_subscription_id work
	if deviceID != "" && invoice.Subscription != nil && invoice.Subscription.ID != "" {
		_, _ = h.billing.DB().Exec(
			`UPDATE subscriptions SET stripe_subscription_id = $1, status = 'active'
			 WHERE device_id = $2`,
			invoice.Subscription.ID, deviceID)
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

// priceToPlanFromSubscription extracts the plan ID from a subscription's price items.
func priceToPlanFromSubscription(sub *stripego.Subscription) string {
	if sub == nil || sub.Items == nil || len(sub.Items.Data) == 0 {
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

// updateDevicePlan updates the plan on both the device and its owning account.
// On plan change, re-provisions the subdomain if no custom domain overrides it.
func (h *BillingHandler) updateDevicePlan(deviceID, planID string) {
	_, _ = h.billing.DB().Exec(
		"UPDATE devices SET plan_id = $1 WHERE id = $2", planID, deviceID)
	_, _ = h.billing.DB().Exec(
		`UPDATE customer_accounts SET plan_id = $1, updated_at = $2
		 WHERE id = (SELECT account_id FROM devices WHERE id = $3)`,
		planID, time.Now(), deviceID)

	// Re-provision the subdomain if no active custom domain overrides it.
	// A custom domain takes precedence over the plan's subdomain pattern.
	services.NewDomainCoordinator(h.billing.DB()).Reconcile(deviceID)
}

// handleDomainGraceOnDowngrade puts a device's active custom domain into grace
// status when the device is downgraded to Free. Disables CF auto-renew so the
// domain expires naturally. The scheduler revokes DNS after expiry.
func (h *BillingHandler) handleDomainGraceOnDowngrade(ctx context.Context, deviceID string) {
	var domain string
	var expiresAt sql.NullTime
	err := h.billing.DB().QueryRowContext(ctx,
		`SELECT domain, expires_at FROM custom_domains WHERE device_id = $1 AND status = 'active'`,
		deviceID).Scan(&domain, &expiresAt)
	if err != nil || domain == "" {
		return
	}

	apiToken, cfAccountID, credErr := h.lookUpTunnelCredentials(ctx)
	if credErr == nil {
		if err := h.registrar.UpdateDomainAutoRenew(cfAccountID, apiToken, domain, false); err != nil {
			slog.Warn("failed to disable CF auto-renew on downgrade", "error", err, "domain", domain)
		}
	}

	// Set status='grace' and record grace_until as the domain's expiry. Never
	// swallow the failure silently — the domain would keep renewing (and keep
	// serving) on a plan it should no longer hold.
	var uerr error
	if expiresAt.Valid {
		_, uerr = h.billing.DB().ExecContext(ctx,
			`UPDATE custom_domains SET status = 'grace', auto_renew = FALSE, grace_until = $1 WHERE domain = $2`,
			expiresAt.Time, domain)
	} else {
		_, uerr = h.billing.DB().ExecContext(ctx,
			`UPDATE custom_domains SET status = 'grace', auto_renew = FALSE WHERE domain = $1`,
			domain)
	}
	if uerr != nil {
		slog.Error("downgrade: could not put custom domain into grace", "error", uerr, "domain", domain, "device", deviceID)
		return
	}
	slog.Info("custom domain entered grace on downgrade", "domain", domain, "device", deviceID)
}

// lookUpTunnelCredentials queries the service_providers table for the enabled
// tunnel provider and returns the API token and account ID.
func (h *BillingHandler) lookUpTunnelCredentials(ctx context.Context) (apiToken, accountID string, err error) {
	var credentialsJSON, settingsJSON sql.NullString
	err = h.billing.DB().QueryRowContext(ctx,
		`SELECT credentials_json, settings_json FROM service_providers WHERE service = 'tunnel' AND enabled = TRUE LIMIT 1`,
	).Scan(&credentialsJSON, &settingsJSON)
	if err != nil {
		return "", "", fmt.Errorf("no tunnel provider configured")
	}
	var creds map[string]any
	json.Unmarshal([]byte(credentialsJSON.String), &creds)
	if t, ok := creds["api_token"].(string); ok {
		apiToken = t
	}
	var settings map[string]any
	json.Unmarshal([]byte(settingsJSON.String), &settings)
	if a, ok := settings["account_id"].(string); ok {
		accountID = a
	}
	return apiToken, accountID, nil
}

// cancelOldDomain cancels the device's current custom domain (if any) by
// disabling CF auto-renew and setting status='cancelled'. Used during domain
// change to clean up the old domain before activating the new one.
func (h *BillingHandler) cancelOldDomain(deviceID, apiToken, cfAccountID string) {
	var oldDomain string
	err := h.billing.DB().QueryRow(
		`SELECT domain FROM custom_domains WHERE device_id = $1 AND status IN ('active', 'grace')`,
		deviceID).Scan(&oldDomain)
	if err != nil || oldDomain == "" {
		return
	}
	if err := h.registrar.UpdateDomainAutoRenew(cfAccountID, apiToken, oldDomain, false); err != nil {
		slog.Warn("failed to disable auto-renew on old domain", "error", err, "domain", oldDomain)
	}
	if _, err := h.billing.DB().Exec(
		`UPDATE custom_domains SET status = 'cancelled', auto_renew = FALSE WHERE domain = $1`,
		oldDomain); err != nil {
		// Never swallow: the old domain would keep renewing (and billing)
		// while the new one serves.
		slog.Error("failed to cancel old domain after change", "error", err, "domain", oldDomain)
		return
	}
	slog.Info("cancelled old domain for device", "domain", oldDomain, "device", deviceID)
}
