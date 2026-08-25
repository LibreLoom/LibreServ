package billing

import (
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/customer"
	"github.com/stripe/stripe-go/v76/paymentintent"
	"github.com/stripe/stripe-go/v76/paymentmethod"
	"github.com/stripe/stripe-go/v76/subscription"
	"github.com/stripe/stripe-go/v76/usagerecord"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

const DollarsPerTB = 7.0
const BytesPerTB = 1_000_000_000_000

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
		Description: stripe.String("Luna Connect: a dollar to confirm this is a real person. It counts toward cloud backup if you turn it on."),
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
	params := &stripe.SubscriptionParams{
		Customer:             stripe.String(customerID),
		DefaultPaymentMethod: stripe.String(paymentMethodID),
		Items: []*stripe.SubscriptionItemsParams{{
			Price: stripe.String(config.C.Stripe.PriceID),
		}},
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

func ReportUsage(db *sql.DB) {
	if !config.C.Stripe.Ready() {
		return
	}
	stripe.Key = config.C.Stripe.SecretKey
	rows, err := db.Query(`
SELECT a.stripe_subscription_item_id, COALESCE(SUM(b.size), 0)
FROM accounts a
LEFT JOIN backup_objects b ON b.account_id = a.id
WHERE a.stripe_subscription_item_id IS NOT NULL AND a.stripe_subscription_item_id != '' AND a.has_card = 1
GROUP BY a.id`)
	if err != nil {
		slog.Warn("usage query failed", "error", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var itemID string
		var bytes int64
		if err := rows.Scan(&itemID, &bytes); err != nil {
			continue
		}
		if !strings.HasPrefix(itemID, "si_") {
			slog.Warn("skip usage: not a subscription item id")
			continue
		}
		tbTenths := bytes * 10 / BytesPerTB
		if tbTenths < 1 && bytes > 0 {
			tbTenths = 1
		}
		_, err := usagerecord.New(&stripe.UsageRecordParams{
			SubscriptionItem: stripe.String(itemID),
			Quantity:         stripe.Int64(tbTenths),
			Timestamp:        stripe.Int64(time.Now().Unix()),
			Action:           stripe.String(string(stripe.UsageRecordActionSet)),
		})
		if err != nil {
			slog.Warn("stripe usage failed", "error", err)
		}
	}
}
