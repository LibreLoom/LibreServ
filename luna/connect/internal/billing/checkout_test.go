package billing

import (
	"errors"
	"testing"

	"github.com/stripe/stripe-go/v87"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestCheckoutFromSessionCardCheck(t *testing.T) {
	s := &stripe.CheckoutSession{
		ID:            "cs_1",
		Status:        stripe.CheckoutSessionStatusComplete,
		PaymentStatus: stripe.CheckoutSessionPaymentStatusUnpaid,
		Metadata:      map[string]string{"luna_kind": CheckoutCardCheck, "account_id": "acct_1"},
		Customer:      &stripe.Customer{ID: "cus_1"},
		PaymentIntent: &stripe.PaymentIntent{ID: "pi_1"},
	}
	if c := CheckoutFromSession(s); c.Done {
		t.Fatal("an unpaid card check (bank transfer still pending) must not count as done")
	}
	s.PaymentStatus = stripe.CheckoutSessionPaymentStatusPaid
	c := CheckoutFromSession(s)
	if !c.Done || c.Kind != CheckoutCardCheck || c.AccountID != "acct_1" || c.CustomerID != "cus_1" || c.PaymentIntent != "pi_1" {
		t.Fatalf("paid card check: %+v", c)
	}
}

func TestCheckoutFromSessionBackup(t *testing.T) {
	// A metered subscription's first invoice is $0, so Stripe reports the
	// session as unpaid even when it worked.
	s := &stripe.CheckoutSession{
		ID:                "cs_2",
		Status:            stripe.CheckoutSessionStatusComplete,
		PaymentStatus:     stripe.CheckoutSessionPaymentStatusUnpaid,
		ClientReferenceID: "acct_2",
		Metadata:          map[string]string{"luna_kind": CheckoutBackup},
		Subscription:      &stripe.Subscription{ID: "sub_2"},
	}
	c := CheckoutFromSession(s)
	if !c.Done || c.SubscriptionID != "sub_2" || c.AccountID != "acct_2" {
		t.Fatalf("backup checkout: %+v", c)
	}
	s.Status = stripe.CheckoutSessionStatusOpen
	if CheckoutFromSession(s).Done {
		t.Fatal("an open session is not done")
	}
}

func TestCheckoutFromSessionUnknownKind(t *testing.T) {
	s := &stripe.CheckoutSession{Status: stripe.CheckoutSessionStatusComplete, PaymentStatus: stripe.CheckoutSessionPaymentStatusPaid}
	if CheckoutFromSession(s).Done {
		t.Fatal("a session we did not start must never count as done")
	}
}

func TestGrantCreditValidates(t *testing.T) {
	if err := GrantCredit("cus_x", 0, CreditPaid, "x", ""); !errors.Is(err, ErrCreditAmountInvalid) {
		t.Fatalf("zero: %v", err)
	}
	if err := GrantCredit("cus_x", 100, CreditPaid, "  ", ""); !errors.Is(err, ErrCreditReasonRequired) {
		t.Fatalf("no reason: %v", err)
	}
}

func TestGrantCreditNeedsRealCustomer(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "")
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = "sk_test_fake"
	if err := GrantCredit("cus_dev_a@b.co", 100, CreditPromotional, "sorry", ""); !errors.Is(err, ErrNoStripeCustomer) {
		t.Fatalf("placeholder customer: %v", err)
	}
}
