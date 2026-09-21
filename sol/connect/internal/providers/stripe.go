package providers

import (
	"context"
	"fmt"

	stripego "github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/checkout/session"
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
		SubscriptionData: &stripego.CheckoutSessionSubscriptionDataParams{
			Metadata: map[string]string{
				"device_id": deviceID,
			},
		},
	}
	params.Context = ctx

	s, err := session.New(params)
	if err != nil {
		return "", fmt.Errorf("create checkout session: %w", err)
	}
	return s.URL, nil
}

// CreateDomainCheckoutSession creates a Stripe Checkout session for a one-time
// domain registration payment. The domain name, device ID, and account ID are
// stored in metadata so the webhook handler can register the domain after payment succeeds.
func CreateDomainCheckoutSession(ctx context.Context, deviceID, accountID, domainName string, amountCents int64, successURL, cancelURL string) (sessionURL string, err error) {
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
			"account_id":   accountID,
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

// SetCancelAtPeriodEnd marks a Stripe subscription to cancel at the end of the
// current billing period (true) or resumes it (false). The subscription stays
// active until the period ends; Stripe fires customer.subscription.deleted then.
func SetCancelAtPeriodEnd(ctx context.Context, subscriptionID string, cancelAtPeriodEnd bool) error {
	params := &stripego.SubscriptionParams{}
	params.Context = ctx
	params.CancelAtPeriodEnd = stripego.Bool(cancelAtPeriodEnd)

	_, err := subscription.Update(subscriptionID, params)
	if err != nil {
		return fmt.Errorf("set cancel_at_period_end: %w", err)
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

// GetSubscription retrieves a full subscription by ID from the Stripe API,
// including its line items. Used by the webhook handler when the webhook
// event contains an unexpanded subscription reference.
func GetSubscription(ctx context.Context, subscriptionID string) (*stripego.Subscription, error) {
	params := &stripego.SubscriptionParams{}
	params.AddExpand("items.data.price")
	params.Context = ctx
	sub, err := subscription.Get(subscriptionID, params)
	if err != nil {
		return nil, fmt.Errorf("retrieve subscription: %w", err)
	}
	return sub, nil
}
