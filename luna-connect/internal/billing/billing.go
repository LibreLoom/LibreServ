package billing

import (
	"database/sql"
	"log/slog"
	"time"

	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/customer"
	"github.com/stripe/stripe-go/v76/subscription"
	"github.com/stripe/stripe-go/v76/usagerecord"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

const DollarsPerTB = 7.0
const BytesPerTB = 1_000_000_000_000

func EstimateUSD(bytes int64) float64 {
	return float64(bytes) / float64(BytesPerTB) * DollarsPerTB
}

func CreateCustomer(email string) (string, error) {
	if !config.C.Stripe.Ready() {
		return "cus_dev_" + email, nil
	}
	stripe.Key = config.C.Stripe.SecretKey
	c, err := customer.New(&stripe.CustomerParams{Email: stripe.String(email)})
	if err != nil {
		return "", err
	}
	return c.ID, nil
}

func Subscribe(customerID string) (string, error) {
	if !config.C.Stripe.Ready() {
		return "sub_dev", nil
	}
	stripe.Key = config.C.Stripe.SecretKey
	params := &stripe.SubscriptionParams{
		Customer: stripe.String(customerID),
		Items: []*stripe.SubscriptionItemsParams{{
			Price: stripe.String(config.C.Stripe.PriceID),
		}},
	}
	s, err := subscription.New(params)
	if err != nil {
		return "", err
	}
	return s.ID, nil
}

func ReportUsage(db *sql.DB) {
	if !config.C.Stripe.Ready() {
		return
	}
	stripe.Key = config.C.Stripe.SecretKey
	rows, err := db.Query(`
SELECT a.stripe_subscription_id, COALESCE(SUM(b.size), 0)
FROM accounts a
LEFT JOIN backup_objects b ON b.account_id = a.id
WHERE a.stripe_subscription_id IS NOT NULL AND a.stripe_subscription_id != '' AND a.has_card = 1
GROUP BY a.id`)
	if err != nil {
		slog.Warn("usage query failed", "error", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var subID string
		var bytes int64
		if err := rows.Scan(&subID, &bytes); err != nil {
			continue
		}
		tbTenths := bytes * 10 / BytesPerTB
		if tbTenths < 1 && bytes > 0 {
			tbTenths = 1
		}
		_, err := usagerecord.New(&stripe.UsageRecordParams{
			SubscriptionItem: stripe.String(subID),
			Quantity:         stripe.Int64(tbTenths),
			Timestamp:        stripe.Int64(time.Now().Unix()),
			Action:           stripe.String(string(stripe.UsageRecordActionSet)),
		})
		if err != nil {
			slog.Warn("stripe usage failed", "error", err)
		}
	}
}
