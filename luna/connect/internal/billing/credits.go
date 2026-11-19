package billing

import (
	"errors"
	"strings"

	"github.com/stripe/stripe-go/v87"
	"github.com/stripe/stripe-go/v87/billing/creditbalancesummary"
	"github.com/stripe/stripe-go/v87/billing/creditgrant"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

// Account credit lives in Stripe as billing credits (credit grants). Stripe
// takes it off each finalized cloud backup invoice after discounts and before
// tax, so VAT is charged on what the person actually pays, and carries any
// rest over to the next month. Grants only cover metered prices, which is all
// cloud backup bills.

var (
	// ErrCreditAmountInvalid: a credit must be a positive number of cents.
	ErrCreditAmountInvalid = errors.New("credit amount must be positive")
	// ErrCreditReasonRequired: every credit says why it was given.
	ErrCreditReasonRequired = errors.New("a credit needs a reason")
	// ErrNoStripeCustomer: credit needs a Stripe customer, which an account
	// gets with its first checkout.
	ErrNoStripeCustomer = errors.New("account has no stripe customer yet")
)

// Credit categories: what the person paid for (the card check) versus
// credit we give away (an admin's goodwill credit). Stripe spends promotional
// credit first.
const (
	CreditPaid        = "paid"
	CreditPromotional = "promotional"
)

// GrantCredit gives a customer cents of cloud backup credit. idemKey makes a
// retried call (a webhook delivered twice, the return page racing the
// webhook) grant only once; pass "" when every call is a new credit.
func GrantCredit(customerID string, cents int64, category, reason, idemKey string) error {
	return GrantCreditBy(customerID, cents, category, reason, "", idemKey)
}

// GrantCreditBy is GrantCredit with the staff member who gave it, kept on the
// grant so a balance can always be explained.
func GrantCreditBy(customerID string, cents int64, category, reason, adminID, idemKey string) error {
	if cents <= 0 {
		return ErrCreditAmountInvalid
	}
	if strings.TrimSpace(reason) == "" {
		return ErrCreditReasonRequired
	}
	if DevBypass() {
		return nil
	}
	if err := requireLiveStripe(); err != nil {
		return err
	}
	if IsPlaceholderCustomer(customerID) {
		return ErrNoStripeCustomer
	}
	stripe.Key = config.Stripe().SecretKey
	params := &stripe.BillingCreditGrantParams{
		Customer: stripe.String(customerID),
		Name:     stripe.String(reason),
		Category: stripe.String(category),
		Amount: &stripe.BillingCreditGrantAmountParams{
			Type: stripe.String("monetary"),
			Monetary: &stripe.BillingCreditGrantAmountMonetaryParams{
				Currency: stripe.String(string(stripe.CurrencyUSD)),
				Value:    stripe.Int64(cents),
			},
		},
		ApplicabilityConfig: &stripe.BillingCreditGrantApplicabilityConfigParams{
			Scope: &stripe.BillingCreditGrantApplicabilityConfigScopeParams{PriceType: stripe.String("metered")},
		},
	}
	if adminID != "" {
		params.Metadata = map[string]string{"admin_id": adminID}
	}
	if idemKey != "" {
		params.SetIdempotencyKey(idemKey)
	}
	_, err := creditgrant.New(params)
	return err
}

// CreditBalanceCents is the customer's unspent cloud backup credit in cents.
// Credit a draft invoice has reserved still counts until it finalizes.
func CreditBalanceCents(customerID string) (int64, error) {
	if DevBypass() || IsPlaceholderCustomer(customerID) {
		return 0, nil
	}
	if err := requireLiveStripe(); err != nil {
		return 0, err
	}
	stripe.Key = config.Stripe().SecretKey
	sum, err := creditbalancesummary.Get(&stripe.BillingCreditBalanceSummaryParams{
		Customer: stripe.String(customerID),
		Filter: &stripe.BillingCreditBalanceSummaryFilterParams{
			Type:               stripe.String("applicability_scope"),
			ApplicabilityScope: &stripe.BillingCreditBalanceSummaryFilterApplicabilityScopeParams{PriceType: stripe.String("metered")},
		},
	})
	if err != nil {
		return 0, err
	}
	var cents int64
	for _, b := range sum.Balances {
		if b == nil || b.LedgerBalance == nil || b.LedgerBalance.Monetary == nil {
			continue
		}
		if b.LedgerBalance.Monetary.Currency == stripe.CurrencyUSD {
			cents += b.LedgerBalance.Monetary.Value
		}
	}
	return cents, nil
}

// CreditEntry is one credit given to an account, newest first in CreditBalance.
type CreditEntry struct {
	ID          string `json:"id"`
	AmountCents int64  `json:"amount_cents"`
	Category    string `json:"category"`
	Reason      string `json:"reason"`
	AdminID     string `json:"admin_id,omitempty"`
	CreatedAt   int64  `json:"created_at"`
	Voided      bool   `json:"voided,omitempty"`
}

// CreditBalance is an account's unspent credit and the credits it was given.
type CreditBalance struct {
	BalanceCents int64         `json:"balance_cents"`
	Entries      []CreditEntry `json:"entries"`
}

// CreditSummary reads the balance and the last 50 credit grants from Stripe.
func CreditSummary(customerID string) (CreditBalance, error) {
	out := CreditBalance{Entries: []CreditEntry{}}
	if DevBypass() || IsPlaceholderCustomer(customerID) {
		return out, nil
	}
	bal, err := CreditBalanceCents(customerID)
	if err != nil {
		return out, err
	}
	out.BalanceCents = bal
	params := &stripe.BillingCreditGrantListParams{Customer: stripe.String(customerID)}
	params.Limit = stripe.Int64(50)
	params.Single = true
	it := creditgrant.List(params)
	for it.Next() {
		g := it.BillingCreditGrant()
		if g == nil || g.Amount == nil || g.Amount.Monetary == nil {
			continue
		}
		out.Entries = append(out.Entries, CreditEntry{
			ID:          g.ID,
			AmountCents: g.Amount.Monetary.Value,
			Category:    string(g.Category),
			Reason:      g.Name,
			AdminID:     g.Metadata["admin_id"],
			CreatedAt:   g.Created,
			Voided:      g.VoidedAt > 0,
		})
	}
	return out, it.Err()
}
