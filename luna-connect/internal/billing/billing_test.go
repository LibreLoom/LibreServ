package billing

import (
	"errors"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestChargeOneDollarDevBypass(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "1")
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = false
	config.C.Stripe.SecretKey = ""
	id, err := ChargeOneDollar("cus_x", "")
	if err != nil || id == "" {
		t.Fatalf("dev bypass: %q %v", id, err)
	}
}

func TestDevBypassRequiresExplicitDevMode(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "")
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = false
	if DevBypass() {
		t.Fatal("stripe.enabled false must not bypass without LUNACONNECT_DEV")
	}
	if BackupsUnlocked(true, "dev") {
		t.Fatal("billing_status=dev must not unlock outside explicit dev")
	}
}

func TestChargeAndSubscribeFailClosedWhenEnabledWithoutKey(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "")
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = ""
	if _, err := ChargeOneDollar("cus_x", "pm_x"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("charge: %v", err)
	}
	if _, _, err := Subscribe("cus_x", "pm_x"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("subscribe: %v", err)
	}
	if _, err := CreateCustomer("a@b.co"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("customer: %v", err)
	}
}

func TestChargeRequiresPaymentMethodWhenStripeReady(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "")
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = "sk_test_fake"
	if _, err := ChargeOneDollar("cus_x", ""); !errors.Is(err, ErrPaymentMethodRequired) {
		t.Fatalf("want payment method required, got %v", err)
	}
	if _, _, err := Subscribe("cus_x", ""); !errors.Is(err, ErrPaymentMethodRequired) {
		t.Fatalf("subscribe want payment method required, got %v", err)
	}
}

func TestBackupsUnlocked(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "1")
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = false
	if !BackupsUnlocked(true, "active") || !BackupsUnlocked(true, "trialing") || !BackupsUnlocked(true, "dev") {
		t.Fatal("dev mode should unlock active/trialing/dev")
	}
	t.Setenv("LUNACONNECT_DEV", "")
	if BackupsUnlocked(true, "dev") {
		t.Fatal("dev status locked without LUNACONNECT_DEV")
	}
	if BackupsUnlocked(false, "active") {
		t.Fatal("no card")
	}
}
