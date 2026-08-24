package billing

import (
	"errors"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestChargeOneDollarDevBypass(t *testing.T) {
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = false
	config.C.Stripe.SecretKey = ""
	id, err := ChargeOneDollar("cus_x", "")
	if err != nil || id == "" {
		t.Fatalf("dev bypass: %q %v", id, err)
	}
}

func TestChargeAndSubscribeFailClosedWhenEnabledWithoutKey(t *testing.T) {
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = ""
	if _, err := ChargeOneDollar("cus_x", "pm_x"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("charge: %v", err)
	}
	if _, err := Subscribe("cus_x"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("subscribe: %v", err)
	}
	if _, err := CreateCustomer("a@b.co"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("customer: %v", err)
	}
}

func TestChargeRequiresPaymentMethodWhenStripeReady(t *testing.T) {
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = "sk_test_fake"
	if _, err := ChargeOneDollar("cus_x", ""); !errors.Is(err, ErrPaymentMethodRequired) {
		t.Fatalf("want payment method required, got %v", err)
	}
}
