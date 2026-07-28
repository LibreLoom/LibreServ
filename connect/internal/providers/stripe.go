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
	}
	params.Context = ctx

	s, err := session.New(params)
	if err != nil {
		return "", fmt.Errorf("create checkout session: %w", err)
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
	// First, retrieve the subscription to get the item ID
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

	// Update the subscription item with the new price
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
