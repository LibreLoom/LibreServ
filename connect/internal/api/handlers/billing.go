package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	stripego "github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/webhook"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
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

	// Check if this is a domain registration payment (metadata.type = domain_registration)
	if session.Metadata != nil && session.Metadata["type"] == "domain_registration" {
		h.handleDomainPurchase(w, r, &session)
		return
	}

	// Otherwise it's a subscription checkout — determine plan from the subscription's price items
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

// handleDomainPurchase registers a domain after the Stripe payment succeeds.
// Called from handleCheckoutCompleted when metadata.type == "domain_registration".
func (h *BillingHandler) handleDomainPurchase(w http.ResponseWriter, r *http.Request, session *stripego.CheckoutSession) {
	domainName := session.Metadata["domain"]
	deviceID := session.Metadata["device_id"]
	if domainName == "" || deviceID == "" {
		slog.Error("domain purchase missing metadata", "metadata", session.Metadata)
		JSONError(w, http.StatusBadRequest, "missing domain metadata")
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

	// Register the domain via Cloudflare Registrar
	if err := h.registrar.RegisterDomain(cfAccountID, apiToken, domainName); err != nil {
		slog.Error("failed to register domain after payment", "error", err, "domain", domainName)
		JSONError(w, http.StatusBadGateway, "could not register domain")
		return
	}

	// Create DNS CNAME to route the custom domain to the device's tunnel.
	// The zone is the registrable domain (e.g. "example.com"); we create a
	// CNAME at the apex or www depending on what the user purchased.
	tunnelID := h.findDeviceTunnelID(deviceID)
	dnsConfigured := false
	if tunnelID != "" {
		// Extract the zone (last two labels for standard TLDs)
		zone := extractZone(domainName)
		cnameTarget := fmt.Sprintf("%s.cfargotunnel.com", tunnelID)
		dnsClient := providers.NewCloudflareClient(nil)
		dnsConfigured, _ = dnsClient.CreateCNAME(apiToken, zone, domainName, cnameTarget)
		if !dnsConfigured {
			slog.Warn("failed to create CNAME for custom domain", "domain", domainName, "tunnel", tunnelID)
		}
	} else {
		slog.Warn("device has no tunnel, cannot route custom domain", "device", deviceID, "domain", domainName)
	}

	// Push domain credentials to the device so Caddy serves the custom domain.
	// This is done by writing to the service_credentials table — the device
	// picks up the credentials on next check-in.
	domainCreds := map[string]any{
		"domain":      domainName,
		"provider":    "connect",
		"auto_https":  true,
		"dns_managed": dnsConfigured,
	}
	credsJSON, _ := json.Marshal(domainCreds)
	_, _ = h.billing.DB().Exec(
		`INSERT INTO service_credentials (id, device_id, service_type, credentials_json, is_active)
		 VALUES ($1, $2, 'domain', $3, TRUE)
		 ON CONFLICT (device_id, service_type) DO UPDATE SET
		   credentials_json = excluded.credentials_json,
		   provisioned_at = CURRENT_TIMESTAMP,
		   is_active = TRUE`,
		security.GenerateID("cred"), deviceID, string(credsJSON))

	// Record the domain purchase in custom_domains
	amountCents := session.AmountTotal
	_, err = h.billing.DB().Exec(
		`INSERT INTO custom_domains (id, device_id, domain, registered_via, registration_cost_cents, auto_renew, status)
		 VALUES ($1, $2, $3, 'cloudflare', $4, TRUE, 'active')
		 ON CONFLICT (domain) DO UPDATE SET status = 'active'`,
		security.GenerateID("dom"), deviceID, domainName, int(amountCents))
	if err != nil {
		slog.Error("failed to record domain purchase", "error", err, "domain", domainName)
	}

	// Create annual renewal subscription so the domain auto-renews each year.
	// We query the current Cloudflare renewal cost and create a dynamic price
	// so we capture today's rate. If the cost changes next year, we update the
	// subscription price before renewal.
	if session.Customer != nil && session.Customer.ID != "" {
		// Get the current renewal cost from Cloudflare
		domainInfo, err := h.registrar.CheckDomain(cfAccountID, apiToken, domainName)
		if err == nil && domainInfo != nil {
			renewalCents, parseErr := parseDomainCostToCents(domainInfo.RenewalCost)
			if parseErr == nil && renewalCents > 0 {
				priceID, err := providers.CreateDomainRenewalPrice(r.Context(), domainName, renewalCents)
				if err != nil {
					slog.Warn("failed to create renewal price", "error", err, "domain", domainName)
				} else {
					subID, err := providers.CreateDomainRenewalSubscription(r.Context(), session.Customer.ID, priceID, domainName)
					if err != nil {
						slog.Warn("failed to create renewal subscription", "error", err, "domain", domainName)
					} else {
						// Store the renewal subscription ID on the custom_domain record
						_, _ = h.billing.DB().Exec(
							`UPDATE custom_domains SET renewal_subscription_id = $1 WHERE domain = $2`,
							subID, domainName)
						slog.Info("domain renewal subscription created", "domain", domainName, "subscription", subID, "annual_cost_cents", renewalCents)
					}
				}
			}
		}
	} else {
		slog.Warn("no customer on checkout session, cannot create renewal subscription", "domain", domainName)
	}

	slog.Info("domain registered after payment", "domain", domainName, "device", deviceID, "cost_cents", amountCents, "dns_configured", dnsConfigured)
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

// findDeviceTunnelID looks up the tunnel ID for a device from service_credentials.
func (h *BillingHandler) findDeviceTunnelID(deviceID string) string {
	var credsJSON string
	err := h.billing.DB().QueryRow(
		`SELECT credentials_json FROM service_credentials
		 WHERE device_id = $1 AND service_type = 'tunnel' AND is_active = TRUE`,
		deviceID).Scan(&credsJSON)
	if err != nil {
		return ""
	}
	var creds struct {
		TunnelID string `json:"tunnel_id"`
	}
	if json.Unmarshal([]byte(credsJSON), &creds) != nil {
		return ""
	}
	return creds.TunnelID
}

// extractZone returns the registrable zone from a domain name.
// e.g. "myapp.example.com" → "example.com", "example.org" → "example.org"
func extractZone(domain string) string {
	parts := strings.Split(domain, ".")
	if len(parts) <= 2 {
		return domain
	}
	return strings.Join(parts[len(parts)-2:], ".")
}
