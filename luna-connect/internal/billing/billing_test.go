package billing

import (
	"errors"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestUsageQuantityGB(t *testing.T) {
	cases := []struct {
		bytes int64
		want  int64
	}{
		{0, 0},
		{1, 1},              // any bytes → at least 1 GB
		{BytesPerGB - 1, 1}, // under 1 GB still 1
		{BytesPerGB, 1},     // exactly 1 GB
		{BytesPerGB + 1, 1}, // floor until 2e9
		{2*BytesPerGB - 1, 1},
		{2 * BytesPerGB, 2},
		{100 * BytesPerGB, 100}, // was one 0.1 TB unit before
		{BytesPerTB, 1000},      // 1 TB = 1000 GB
		{BytesPerTB + BytesPerGB, 1001},
	}
	for _, tc := range cases {
		if got := UsageQuantityGB(tc.bytes); got != tc.want {
			t.Fatalf("UsageQuantityGB(%d)=%d want %d", tc.bytes, got, tc.want)
		}
	}
	// $8/TB still holds at the GB unit price
	if DollarsPerGB*1000 != DollarsPerTB {
		t.Fatalf("DollarsPerGB*1000=%v want %v", DollarsPerGB*1000, DollarsPerTB)
	}
}

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

func TestIsPlaceholderCustomer(t *testing.T) {
	if !IsPlaceholderCustomer("") || !IsPlaceholderCustomer("cus_dev_a@b.co") {
		t.Fatal("expected placeholders")
	}
	if IsPlaceholderCustomer("cus_abc123") {
		t.Fatal("real customer id must not be treated as placeholder")
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

func TestChargeRejectsPlaceholderCustomer(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "")
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = "sk_test_fake"
	if _, err := ChargeOneDollar("cus_dev_a@b.co", "pm_x"); err == nil {
		t.Fatal("expected error for placeholder customer")
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

func TestReportUsageSkipsWithoutMeterEventName(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "")
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe = config.StripeConfig{
		Enabled:        true,
		SecretKey:      "sk_test_fake",
		MeterEventName: "",
	}
	// Must not panic / call Stripe when meter_event_name is empty (nil db is fine — returns early).
	ReportUsage(nil)
}
