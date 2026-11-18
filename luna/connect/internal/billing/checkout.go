package billing

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v87"
	"github.com/stripe/stripe-go/v87/checkout/session"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

// Payments run through Stripe Managed Payments: Stripe (through Link) is the
// merchant of record, so it adds and files sales tax and VAT. Every amount is
// set before tax and Stripe adds tax on top. See docs/billing-managed-payments.md.

// Checkout kinds, stored in the session metadata so the webhook and the
// return page know what the person bought.
const (
	CheckoutCardCheck = "card_check"
	CheckoutBackup    = "backup"
)

// CardCheckCents is the one-time card check. It is sold as prepaid cloud
// backup credit, and the same amount is granted back as credit.
const CardCheckCents = 100

// TaxCode is Stripe's product tax code for cloud storage for personal use
// (Infrastructure as a service). Managed Payments only sells products with an
// eligible digital tax code; the storage and egress products in the Stripe
// Dashboard need the same one.
const TaxCode = "txcd_10010001"

// Checkout is what Connect needs from a finished (or unfinished) Checkout session.
type Checkout struct {
	ID             string
	Kind           string
	AccountID      string
	CustomerID     string
	SubscriptionID string
	PaymentIntent  string
	// From is the page that started it ("onboarding", "diyonboarding", "backups").
	From string
	// Done: the card check is paid, or the subscription exists.
	Done bool
}

// StartCardCheck opens a Stripe Checkout page for the one-time card check and
// returns its address. from names the page that started it; successURL may
// carry {CHECKOUT_SESSION_ID}. The card is
// saved for later, so the backup checkout can offer it in one click.
func StartCardCheck(customerID, accountID, from, successURL, cancelURL string) (string, error) {
	if err := requireLiveStripe(); err != nil {
		return "", err
	}
	if IsPlaceholderCustomer(customerID) {
		return "", fmt.Errorf("stripe customer missing")
	}
	stripe.Key = config.C.Stripe.SecretKey
	meta := map[string]string{"luna_kind": CheckoutCardCheck, "account_id": accountID, "luna_from": from}
	params := &stripe.CheckoutSessionParams{
		Mode:              stripe.String(string(stripe.CheckoutSessionModePayment)),
		Customer:          stripe.String(customerID),
		ClientReferenceID: stripe.String(accountID),
		Metadata:          meta,
		ManagedPayments:   &stripe.CheckoutSessionManagedPaymentsParams{Enabled: stripe.Bool(true)},
		LineItems: []*stripe.CheckoutSessionLineItemParams{{
			Quantity: stripe.Int64(1),
			PriceData: &stripe.CheckoutSessionLineItemPriceDataParams{
				Currency:    stripe.String(string(stripe.CurrencyUSD)),
				UnitAmount:  stripe.Int64(CardCheckCents),
				TaxBehavior: stripe.String("exclusive"),
				ProductData: &stripe.CheckoutSessionLineItemPriceDataProductDataParams{
					Name:        stripe.String("Cloud backup credit"),
					Description: stripe.String("A one-time $1 card check. The dollar counts toward cloud backup."),
					TaxCode:     stripe.String(TaxCode),
				},
			},
		}},
		PaymentIntentData: &stripe.CheckoutSessionPaymentIntentDataParams{
			SetupFutureUsage: stripe.String("off_session"),
			Metadata:         meta,
		},
		SuccessURL: stripe.String(successURL),
		CancelURL:  stripe.String(cancelURL),
	}
	s, err := session.New(params)
	if err != nil {
		return "", err
	}
	return s.URL, nil
}

// StartBackupCheckout opens a Stripe Checkout page for the monthly cloud
// backup subscription (storage, plus egress overage when configured) and
// returns its address. The bill runs from the 1st of each month (UTC), the
// same calendar month the usage meters average over. A card saved by the card
// check is offered again, so subscribing is one click.
func StartBackupCheckout(customerID, accountID, from, successURL, cancelURL string) (string, error) {
	if err := requireLiveStripe(); err != nil {
		return "", err
	}
	if IsPlaceholderCustomer(customerID) {
		return "", fmt.Errorf("stripe customer missing")
	}
	stripe.Key = config.C.Stripe.SecretKey
	items := []*stripe.CheckoutSessionLineItemParams{{Price: stripe.String(config.C.Stripe.PriceID)}}
	if egress := strings.TrimSpace(config.C.Stripe.EgressPriceID); egress != "" {
		items = append(items, &stripe.CheckoutSessionLineItemParams{Price: stripe.String(egress)})
	}
	meta := map[string]string{"luna_kind": CheckoutBackup, "account_id": accountID, "luna_from": from}
	params := &stripe.CheckoutSessionParams{
		Mode:              stripe.String(string(stripe.CheckoutSessionModeSubscription)),
		Customer:          stripe.String(customerID),
		ClientReferenceID: stripe.String(accountID),
		Metadata:          meta,
		ManagedPayments:   &stripe.CheckoutSessionManagedPaymentsParams{Enabled: stripe.Bool(true)},
		LineItems:         items,
		SavedPaymentMethodOptions: &stripe.CheckoutSessionSavedPaymentMethodOptionsParams{
			AllowRedisplayFilters: []*string{stripe.String("limited"), stripe.String("always")},
		},
		SubscriptionData: &stripe.CheckoutSessionSubscriptionDataParams{
			BillingCycleAnchor: stripe.Int64(NextMonthStartUTC(time.Now()).Unix()),
			ProrationBehavior:  stripe.String("none"),
			Metadata:           meta,
		},
		SuccessURL: stripe.String(successURL),
		CancelURL:  stripe.String(cancelURL),
	}
	s, err := session.New(params)
	if err != nil {
		return "", err
	}
	return s.URL, nil
}

// GetCheckout reads a Checkout session from Stripe (the return page path; the
// webhook carries the session itself).
func GetCheckout(sessionID string) (Checkout, error) {
	if err := requireLiveStripe(); err != nil {
		return Checkout{}, err
	}
	stripe.Key = config.C.Stripe.SecretKey
	s, err := session.Get(sessionID, nil)
	if err != nil {
		return Checkout{}, err
	}
	return CheckoutFromSession(s), nil
}

// CheckoutFromEvent reads the session in a checkout.session.* webhook.
func CheckoutFromEvent(raw json.RawMessage) (Checkout, error) {
	var s stripe.CheckoutSession
	if err := json.Unmarshal(raw, &s); err != nil {
		return Checkout{}, err
	}
	return CheckoutFromSession(&s), nil
}

// CheckoutFromSession maps a Stripe session to a Checkout. A card check is done
// once it is paid; some local payment methods pay later, which arrives as
// checkout.session.async_payment_succeeded. A backup checkout is done once the
// subscription exists: its first invoice is $0, so the session stays "unpaid".
func CheckoutFromSession(s *stripe.CheckoutSession) Checkout {
	if s == nil {
		return Checkout{}
	}
	c := Checkout{ID: s.ID, Kind: s.Metadata["luna_kind"], AccountID: s.Metadata["account_id"], From: s.Metadata["luna_from"]}
	if c.AccountID == "" {
		c.AccountID = s.ClientReferenceID
	}
	if s.Customer != nil {
		c.CustomerID = s.Customer.ID
	}
	if s.Subscription != nil {
		c.SubscriptionID = s.Subscription.ID
	}
	if s.PaymentIntent != nil {
		c.PaymentIntent = s.PaymentIntent.ID
	}
	complete := s.Status == stripe.CheckoutSessionStatusComplete
	switch c.Kind {
	case CheckoutCardCheck:
		c.Done = complete && s.PaymentStatus == stripe.CheckoutSessionPaymentStatusPaid
	case CheckoutBackup:
		c.Done = complete && c.SubscriptionID != ""
	}
	return c
}
