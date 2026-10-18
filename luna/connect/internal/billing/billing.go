package billing

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/customer"
	"github.com/stripe/stripe-go/v76/paymentintent"
	"github.com/stripe/stripe-go/v76/setupintent"
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
	// ErrCardNotVerified: the card was declined or could not be saved for monthly billing.
	ErrCardNotVerified = errors.New("card not verified")
)

// CardAction is returned by VerifyCard when the card's bank wants the person to
// confirm in the browser (3D Secure). The browser finishes it with ClientSecret,
// then calls again with SetupIntentID.
type CardAction struct {
	SetupIntentID string
	ClientSecret  string
}

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
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(100),
		Currency:      stripe.String(string(stripe.CurrencyUSD)),
		Customer:      stripe.String(customerID),
		PaymentMethod: stripe.String(paymentMethodID),
		Confirm:       stripe.Bool(true),
		AutomaticPaymentMethods: &stripe.PaymentIntentAutomaticPaymentMethodsParams{
			Enabled:        stripe.Bool(true),
			AllowRedirects: stripe.String("never"),
		},
		Description: stripe.String("Luna Connect: a one-time $1 charge checks that your card works. It counts toward cloud backup if you turn that on."),
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

// VerifyCard saves the card on the customer for monthly billing and confirms
// the bank accepts it. A metered subscription's first invoice is $0, so
// without this a declined card would only show up on the first real invoice.
// Pass setupIntentID on the second call after the browser finished a CardAction.
func VerifyCard(customerID, paymentMethodID, setupIntentID string) (*CardAction, error) {
	if DevBypass() {
		return nil, nil
	}
	if err := requireLiveStripe(); err != nil {
		return nil, err
	}
	if paymentMethodID == "" {
		return nil, ErrPaymentMethodRequired
	}
	if IsPlaceholderCustomer(customerID) {
		return nil, fmt.Errorf("stripe customer missing")
	}
	stripe.Key = config.C.Stripe.SecretKey
	var si *stripe.SetupIntent
	var err error
	if setupIntentID != "" {
		si, err = setupintent.Get(setupIntentID, nil)
		if err != nil {
			return nil, err
		}
		if si.Customer == nil || si.Customer.ID != customerID ||
			si.PaymentMethod == nil || si.PaymentMethod.ID != paymentMethodID {
			return nil, ErrCardNotVerified
		}
	} else {
		si, err = setupintent.New(&stripe.SetupIntentParams{
			Customer:      stripe.String(customerID),
			PaymentMethod: stripe.String(paymentMethodID),
			Confirm:       stripe.Bool(true),
			Usage:         stripe.String(string(stripe.SetupIntentUsageOffSession)),
			AutomaticPaymentMethods: &stripe.SetupIntentAutomaticPaymentMethodsParams{
				Enabled:        stripe.Bool(true),
				AllowRedirects: stripe.String("never"),
			},
		})
		if err != nil {
			return nil, err
		}
	}
	switch si.Status {
	case stripe.SetupIntentStatusSucceeded:
		return nil, nil
	case stripe.SetupIntentStatusRequiresAction:
		return &CardAction{SetupIntentID: si.ID, ClientSecret: si.ClientSecret}, nil
	default:
		return nil, ErrCardNotVerified
	}
}

// NextMonthStartUTC is 00:00 UTC on the 1st of the month after t.
func NextMonthStartUTC(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, time.UTC)
}

// Subscribe starts the monthly metered bill. The card must already be saved
// on the customer (see VerifyCard). Invoices close on the 1st at 00:00 UTC so
// Stripe's billing period matches the UTC calendar month that usage is
// averaged over; the first period is the partial month until then.
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
		BillingCycleAnchor:   stripe.Int64(NextMonthStartUTC(time.Now()).Unix()),
		ProrationBehavior:    stripe.String("none"),
	}
	s, err := subscription.New(params)
	if err != nil {
		return "", "", err
	}
	if s.Status != stripe.SubscriptionStatusActive && s.Status != stripe.SubscriptionStatusTrialing {
		cancelOrphan(s.ID)
		return "", "", ErrSubscriptionInactive
	}
	if s.Items == nil || len(s.Items.Data) == 0 || s.Items.Data[0] == nil || s.Items.Data[0].ID == "" {
		cancelOrphan(s.ID)
		return "", "", fmt.Errorf("subscription item missing")
	}
	return s.ID, s.Items.Data[0].ID, nil
}

// cancelOrphan cancels a subscription we created but will not use, so the
// customer is never left with a stray subscription at Stripe.
func cancelOrphan(subID string) {
	if _, err := subscription.Cancel(subID, nil); err != nil {
		slog.Error("could not cancel unused subscription; cancel it in Stripe", "subscription", subID, "err", err)
	}
}

func CancelSubscription(subID string) error {
	if subID == "" || DevBypass() {
		return nil
	}
	if err := requireLiveStripe(); err != nil {
		return err
	}
	stripe.Key = config.C.Stripe.SecretKey
	_, err := subscription.Cancel(subID, nil)
	return err
}
