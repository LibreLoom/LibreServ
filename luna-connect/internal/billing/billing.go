package billing

import (
	"errors"
	"fmt"
	"strings"

	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/customer"
	"github.com/stripe/stripe-go/v76/paymentintent"
	"github.com/stripe/stripe-go/v76/paymentmethod"
	"github.com/stripe/stripe-go/v76/subscription"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

const DollarsPerTB = 8.0
const DollarsPerGB = 0.008 // $8/TB; Stripe metered unit = 1 decimal GB (average GB-month)
const BytesPerTB = 1_000_000_000_000
const BytesPerGB = 1_000_000_000

var (
	// ErrNotConfigured: Stripe is turned on but not usable (empty secret in production).
	ErrNotConfigured = errors.New("stripe not configured")
	// ErrPaymentMethodRequired: a card id is required when Stripe is live.
	ErrPaymentMethodRequired = errors.New("payment method required")
	// ErrSubscriptionInactive: subscribe succeeded but is not active/trialing.
	ErrSubscriptionInactive = errors.New("subscription not active")
)

func EstimateUSD(bytes int64) float64 {
	return float64(bytes) / float64(BytesPerTB) * DollarsPerTB
}

// UsageQuantityGB is the Stripe metered quantity for average stored backups.
// Unit = 1 decimal GB ($0.008/GB-mo). Floor(bytes/1e9); any stored bytes bills at least 1.
func UsageQuantityGB(bytes int64) int64 {
	if bytes <= 0 {
		return 0
	}
	gb := bytes / BytesPerGB
	if gb < 1 {
		return 1
	}
	return gb
}

// DevBypass is true only with an explicit local/dev env (LUNACONNECT_DEV)
// and Stripe turned off. stripe.enabled: false by itself does not unlock
// production backups.
func DevBypass() bool {
	return config.DevMode() && !config.C.Stripe.Enabled
}

func BackupsUnlocked(hasCard bool, status string) bool {
	if !hasCard {
		return false
	}
	switch status {
	case "active", "trialing":
		return true
	case "dev":
		return DevBypass()
	default:
		return false
	}
}

func requireLiveStripe() error {
	providers.RefreshStripe()
	if DevBypass() {
		return nil
	}
	if !config.C.Stripe.Ready() {
		return ErrNotConfigured
	}
	return nil
}

func CreateCustomer(email string) (string, error) {
	if DevBypass() {
		return "cus_dev_" + email, nil
	}
	if err := requireLiveStripe(); err != nil {
		return "", err
	}
	stripe.Key = config.C.Stripe.SecretKey
	c, err := customer.New(&stripe.CustomerParams{Email: stripe.String(email)})
	if err != nil {
		return "", err
	}
	return c.ID, nil
}

// IsPlaceholderCustomer is true for local/dev fake IDs (cus_dev_…) that are not
// real Stripe customers. Accounts created before Stripe was configured often have these.
func IsPlaceholderCustomer(customerID string) bool {
	id := strings.TrimSpace(customerID)
	return id == "" || strings.HasPrefix(id, "cus_dev_")
}

// EnsureCustomer returns a usable Stripe customer id. If existing is a real
// Stripe customer it is reused; placeholders are replaced by CreateCustomer.
func EnsureCustomer(email, existing string) (string, error) {
	if !IsPlaceholderCustomer(existing) {
		return strings.TrimSpace(existing), nil
	}
	return CreateCustomer(email)
}

func ChargeOneDollar(customerID, paymentMethodID string) (paymentIntentID string, err error) {
	if DevBypass() {
		return "pi_dev_verify_" + customerID, nil
	}
	if err := requireLiveStripe(); err != nil {
		return "", err
	}
	if paymentMethodID == "" {
		return "", ErrPaymentMethodRequired
	}
	if IsPlaceholderCustomer(customerID) {
		return "", fmt.Errorf("stripe customer missing")
	}
	stripe.Key = config.C.Stripe.SecretKey
	_, _ = paymentmethod.Attach(paymentMethodID, &stripe.PaymentMethodAttachParams{
		Customer: stripe.String(customerID),
	})
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(100),
		Currency:      stripe.String(string(stripe.CurrencyUSD)),
		Customer:      stripe.String(customerID),
		PaymentMethod: stripe.String(paymentMethodID),
		Confirm:       stripe.Bool(true),
		OffSession:    stripe.Bool(false),
		Description:   stripe.String("Luna Connect: a dollar to confirm this is a real person. It counts toward cloud backup if you turn it on."),
	}
	pi, err := paymentintent.New(params)
	if err != nil {
		return "", err
	}
	if pi.Status != stripe.PaymentIntentStatusSucceeded {
		return "", fmt.Errorf("payment not succeeded")
	}
	return pi.ID, nil
}

func Subscribe(customerID, paymentMethodID string) (subID, itemID string, err error) {
	if DevBypass() {
		return "sub_dev", "si_dev", nil
	}
	if err := requireLiveStripe(); err != nil {
		return "", "", err
	}
	if paymentMethodID == "" {
		return "", "", ErrPaymentMethodRequired
	}
	stripe.Key = config.C.Stripe.SecretKey
	_, _ = paymentmethod.Attach(paymentMethodID, &stripe.PaymentMethodAttachParams{
		Customer: stripe.String(customerID),
	})
	items := []*stripe.SubscriptionItemsParams{{
		Price: stripe.String(config.C.Stripe.PriceID),
	}}
	if egress := strings.TrimSpace(config.C.Stripe.EgressPriceID); egress != "" {
		items = append(items, &stripe.SubscriptionItemsParams{
			Price: stripe.String(egress),
		})
	}
	params := &stripe.SubscriptionParams{
		Customer:             stripe.String(customerID),
		DefaultPaymentMethod: stripe.String(paymentMethodID),
		Items:                items,
	}
	s, err := subscription.New(params)
	if err != nil {
		return "", "", err
	}
	if s.Status != stripe.SubscriptionStatusActive && s.Status != stripe.SubscriptionStatusTrialing {
		return "", "", ErrSubscriptionInactive
	}
	if s.Items == nil || len(s.Items.Data) == 0 || s.Items.Data[0] == nil || s.Items.Data[0].ID == "" {
		return "", "", fmt.Errorf("subscription item missing")
	}
	return s.ID, s.Items.Data[0].ID, nil
}
