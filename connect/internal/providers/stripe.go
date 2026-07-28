package providers

import (
	"context"
	"fmt"

	stripego "github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/checkout/session"
	"github.com/stripe/stripe-go/v76/price"
	"github.com/stripe/stripe-go/v76/subscription"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
)

// InitStripe initializes the Stripe SDK with the configured secret key.
// Must be called once at startup before any Stripe operations.
func InitStripe() {
	stripego.Key = config.C.Stripe.SecretKey
}

// CreateCheckoutSession creates a Stripe Checkout session for subscribing to a plan.
// deviceID is used as client_reference_id so we can link the checkout back to our device.
// successURL and cancelURL are the redirect URLs after payment.
func CreateCheckoutSession(ctx context.Context, priceID, deviceID, successURL, cancelURL string) (sessionURL string, err error) {
	params := &stripego.CheckoutSessionParams{
		Mode: stripego.String(string(stripego.CheckoutSessionModeSubscription)),
		LineItems: []*stripego.CheckoutSessionLineItemParams{
			{
				Price:    stripego.String(priceID),
				Quantity: stripego.Int64(1),
			},
		},
		SuccessURL:          stripego.String(successURL),
		CancelURL:           stripego.String(cancelURL),
		ClientReferenceID:   stripego.String(deviceID),
		AllowPromotionCodes: stripego.Bool(true),
	}
	params.Context = ctx

	s, err := session.New(params)
	if err != nil {
		return "", fmt.Errorf("create checkout session: %w", err)
	}
	return s.URL, nil
}

// CreateDomainCheckoutSession creates a Stripe Checkout session for a one-time
// domain registration payment. The domain name and device ID are stored in
// metadata so the webhook handler can register the domain after payment succeeds.
func CreateDomainCheckoutSession(ctx context.Context, deviceID, domainName string, amountCents int64, successURL, cancelURL string) (sessionURL string, err error) {
	params := &stripego.CheckoutSessionParams{
		Mode: stripego.String(string(stripego.CheckoutSessionModePayment)),
		LineItems: []*stripego.CheckoutSessionLineItemParams{
			{
				PriceData: &stripego.CheckoutSessionLineItemPriceDataParams{
					Currency: stripego.String("usd"),
					ProductData: &stripego.CheckoutSessionLineItemPriceDataProductDataParams{
						Name: stripego.String(fmt.Sprintf("Domain registration: %s (1 year)", domainName)),
					},
					UnitAmount: stripego.Int64(amountCents),
				},
				Quantity: stripego.Int64(1),
			},
		},
		SuccessURL:        stripego.String(successURL),
		CancelURL:         stripego.String(cancelURL),
		ClientReferenceID: stripego.String(deviceID),
		Metadata: map[string]string{
			"type":         "domain_registration",
			"domain":       domainName,
			"device_id":    deviceID,
			"amount_cents": fmt.Sprintf("%d", amountCents),
		},
	}
	params.Context = ctx

	s, err := session.New(params)
	if err != nil {
		return "", fmt.Errorf("create domain checkout session: %w", err)
	}
	return s.URL, nil
}

// CancelSubscription cancels a Stripe subscription immediately.
func CancelSubscription(ctx context.Context, subscriptionID string) error {
	params := &stripego.SubscriptionCancelParams{}
	params.Context = ctx

	_, err := subscription.Cancel(subscriptionID, params)
	if err != nil {
		return fmt.Errorf("cancel subscription: %w", err)
	}
	return nil
}

// UpdateSubscriptionPrice changes the price on an active subscription.
// Stripe prorates automatically.
func UpdateSubscriptionPrice(ctx context.Context, subscriptionID, newPriceID string) error {
	subParams := &stripego.SubscriptionParams{}
	subParams.Context = ctx

	s, err := subscription.Get(subscriptionID, subParams)
	if err != nil {
		return fmt.Errorf("get subscription: %w", err)
	}

	if len(s.Items.Data) == 0 {
		return fmt.Errorf("subscription has no items")
	}

	itemID := s.Items.Data[0].ID

	updateParams := &stripego.SubscriptionParams{
		Items: []*stripego.SubscriptionItemsParams{
			{
				ID:    stripego.String(itemID),
				Price: stripego.String(newPriceID),
			},
		},
	}
	updateParams.Context = ctx

	_, err = subscription.Update(subscriptionID, updateParams)
	if err != nil {
		return fmt.Errorf("update subscription price: %w", err)
	}
	return nil
}

// CreateDomainRenewalPrice creates a dynamic Stripe price for annual domain
// renewal at the current Cloudflare at-cost rate. Prices are created per-domain
// because renewal costs vary by TLD and can change over time.
// Returns the price ID to use for the renewal subscription.
func CreateDomainRenewalPrice(ctx context.Context, domainName string, renewalCostCents int64) (priceID string, err error) {
	priceParams := &stripego.PriceParams{
		Currency: stripego.String("usd"),
		ProductData: &stripego.PriceProductDataParams{
			Name: stripego.String(fmt.Sprintf("Domain renewal: %s (annual)", domainName)),
		},
		UnitAmount: stripego.Int64(renewalCostCents),
		Recurring: &stripego.PriceRecurringParams{
			Interval: stripego.String("year"),
		},
		Metadata: map[string]string{
			"type":   "domain_renewal",
			"domain": domainName,
		},
	}
	priceParams.Context = ctx

	newPrice, err := price.New(priceParams)
	if err != nil {
		return "", fmt.Errorf("create renewal price: %w", err)
	}
	return newPrice.ID, nil
}

// CreateDomainRenewalSubscription creates an annual subscription for domain
// renewal using a dynamically-created price. The subscription is attached to
// the customer from the initial checkout. Returns the subscription ID.
// The subscription will auto-charge each year on the anniversary.
func CreateDomainRenewalSubscription(ctx context.Context, customerID, priceID, domainName string) (subscriptionID string, err error) {
	params := &stripego.SubscriptionParams{
		Customer: stripego.String(customerID),
		Items: []*stripego.SubscriptionItemsParams{
			{
				Price: stripego.String(priceID),
			},
		},
		Metadata: map[string]string{
			"type":   "domain_renewal",
			"domain": domainName,
		},
	}
	params.Context = ctx

	sub, err := subscription.New(params)
	if err != nil {
		return "", fmt.Errorf("create renewal subscription: %w", err)
	}
	return sub.ID, nil
}
