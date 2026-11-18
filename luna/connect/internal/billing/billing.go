package billing

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v87"
	"github.com/stripe/stripe-go/v87/customer"
	"github.com/stripe/stripe-go/v87/invoice"
	"github.com/stripe/stripe-go/v87/subscription"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

const DollarsPerTB = 8.0
const DollarsPerGB = 0.008 // $8/TB; Stripe metered unit = 1 decimal GB (average GB-month)
const BytesPerTB = 1_000_000_000_000
const BytesPerGB = 1_000_000_000

// MinimumMonthlyUSD is the least a month of cloud backup can cost. It applies
// to the month's whole bill (storage + egress overage), not to storage alone,
// and only once the account actually stores something: an account with a card
// and nothing uploaded is never charged.
//
// The floor rides on the storage meter, so the reported storage quantity is
// topped up until storage + egress reaches it. Stripe's price is untouched:
// the same $0.008/GB price bills the top-up. See ReportUsage.
const MinimumMonthlyUSD = 3.00

// MinBillableGB is the storage quantity that bills exactly MinimumMonthlyUSD
// at DollarsPerGB. 375 × $0.008 = $3.00. Both constants move together; a test
// pins the relationship.
const MinBillableGB = 375

// MillsPerGBStorage and MillsPerGBEgress are the per-GB prices in thousandths
// of a cent, so the floor arithmetic stays in integers. $0.008 = 8 mills,
// $0.01 = 10 mills, $3.00 = 3000 mills.
const (
	MillsPerGBStorage = 8
	MillsPerGBEgress  = 10
	MillsPerDollar    = 1000
)

// MinimumMonthlyMills is MinimumMonthlyUSD in thousandths of a cent.
const MinimumMonthlyMills int64 = 3000

var (
	// ErrNotConfigured: Stripe is turned on but not usable (empty secret in production).
	ErrNotConfigured = errors.New("stripe not configured")
	// ErrCheckoutNotFinished: the Checkout session is not paid or complete yet.
	ErrCheckoutNotFinished = errors.New("checkout not finished")
)

// EstimateUSD is the month's bill for an account storing bytes with no egress
// overage. It goes through MeteredQuantities, the same function the meters are
// reported from, so the number shown is the number charged.
func EstimateUSD(bytes int64) float64 {
	return EstimateMonthUSD(bytes, 0)
}

// UsageQuantityGB is the raw storage quantity for average stored backups, in
// whole GB, with no minimum applied. Unit = 1 decimal GB ($0.008/GB-mo).
//
// The monthly minimum is NOT applied here: it is a floor on the month's whole
// bill (storage + egress), so it lives in MeteredQuantities, which can see both
// meters. Flooring storage on its own would put egress on top of the minimum
// instead of counting toward it. Nothing stored reports nothing.
func UsageQuantityGB(bytes int64) int64 {
	if bytes <= 0 {
		return 0
	}
	return bytes / BytesPerGB
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

// NextMonthStartUTC is 00:00 UTC on the 1st of the month after t.
func NextMonthStartUTC(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, time.UTC)
}

// FinalChargeDelay is how far ahead "Turn off payment" schedules the end of
// the subscription. Stripe processes meter events about a minute after we send
// them (measured in the sandbox: over 45 seconds), and an invoice cut before
// then bills the month as nothing. Ending the subscription a little later lets
// Stripe bill the usage we just reported on the final invoice itself.
const FinalChargeDelay = 10 * time.Minute

// ScheduleFinalCharge ends the subscription FinalChargeDelay from now (or at
// the end of the current period, if that comes first) without prorating.
// Stripe then cuts a final invoice for the month's metered usage. Report the
// account's usage first (ReportAccountUsage). Returns when it ends.
func ScheduleFinalCharge(subID string) (time.Time, error) {
	if subID == "" || DevBypass() {
		return time.Now(), nil
	}
	if err := requireLiveStripe(); err != nil {
		return time.Time{}, err
	}
	stripe.Key = config.C.Stripe.SecretKey
	sub, err := subscription.Get(subID, nil)
	if err != nil {
		return time.Time{}, err
	}
	at := time.Now().Add(FinalChargeDelay)
	params := &stripe.SubscriptionParams{ProrationBehavior: stripe.String("none")}
	periodEnd := int64(0)
	if sub.Items != nil && len(sub.Items.Data) > 0 && sub.Items.Data[0] != nil {
		periodEnd = sub.Items.Data[0].CurrentPeriodEnd
	}
	if periodEnd > 0 && at.Unix() >= periodEnd {
		// The month ends first: its regular invoice bills it, and the
		// subscription stops there.
		params.CancelAtPeriodEnd = stripe.Bool(true)
		at = time.Unix(periodEnd, 0)
	} else {
		params.CancelAt = stripe.Int64(at.Unix())
	}
	if _, err := subscription.Update(subID, params); err != nil {
		return time.Time{}, err
	}
	return at, nil
}

// SettleFinalInvoice finalizes and charges a just-ended subscription's final
// invoice. Stripe would finalize the draft by itself within about an hour;
// doing it here charges the month right away. A charge that fails stays on the
// open invoice for Stripe to retry.
func SettleFinalInvoice(subID string) error {
	if subID == "" || DevBypass() {
		return nil
	}
	if err := requireLiveStripe(); err != nil {
		return err
	}
	stripe.Key = config.C.Stripe.SecretKey
	params := &stripe.SubscriptionParams{}
	params.AddExpand("latest_invoice")
	sub, err := subscription.Get(subID, params)
	if err != nil {
		return err
	}
	inv := sub.LatestInvoice
	if inv == nil || inv.ID == "" || inv.Status != stripe.InvoiceStatusDraft {
		return nil
	}
	final, err := invoice.FinalizeInvoice(inv.ID, nil)
	if err != nil {
		return fmt.Errorf("finalize final invoice %s: %w", inv.ID, err)
	}
	if final.Status == stripe.InvoiceStatusOpen && final.AmountDue > 0 {
		if _, err := invoice.Pay(final.ID, nil); err != nil {
			return fmt.Errorf("charge final invoice %s: %w", final.ID, err)
		}
	}
	return nil
}

// CancelSubscription ends a subscription now without billing the month so far.
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

// SubscriptionStatus is the subscription's current status at Stripe
// ("active", "past_due", "canceled", …).
func SubscriptionStatus(subID string) (string, error) {
	if DevBypass() {
		return "active", nil
	}
	if err := requireLiveStripe(); err != nil {
		return "", err
	}
	stripe.Key = config.C.Stripe.SecretKey
	s, err := subscription.Get(subID, nil)
	if err != nil {
		return "", err
	}
	return string(s.Status), nil
}

// OpenInvoiceURL is the Stripe page for the subscription's latest invoice
// while it is still unpaid ("open"), or "" when there is none. On that page
// (sold through Link under Managed Payments) the customer can confirm the
// payment with their bank or pay with a different card.
func OpenInvoiceURL(subID string) (string, error) {
	if subID == "" || DevBypass() {
		return "", nil
	}
	if err := requireLiveStripe(); err != nil {
		return "", err
	}
	stripe.Key = config.C.Stripe.SecretKey
	params := &stripe.SubscriptionParams{}
	params.AddExpand("latest_invoice")
	sub, err := subscription.Get(subID, params)
	if err != nil {
		return "", err
	}
	inv := sub.LatestInvoice
	if inv == nil || inv.Status != stripe.InvoiceStatusOpen {
		return "", nil
	}
	return inv.HostedInvoiceURL, nil
}
