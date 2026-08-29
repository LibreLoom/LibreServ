package providers

import (
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

func TestRefreshStripeLoadsPeerAdminWrite(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}

	prev := config.C.Stripe
	t.Cleanup(func() {
		config.C.Stripe = prev
		SetStripeRuntimeDB(nil)
		CaptureStripeBase()
	})

	config.C.Stripe = config.StripeConfig{Enabled: false, SecretKey: "sk_yaml", WebhookSecret: "whsec_yaml"}
	CaptureStripeBase()
	SetStripeRuntimeDB(db)

	// Simulate another blue/green instance writing Stripe to the shared DB
	// without calling ApplyStripeFromDB on this process.
	svc := NewService(db)
	_, err = svc.Create("stripe", "Stripe", map[string]string{
		"secret_key":     "sk_from_peer",
		"webhook_secret": "whsec_from_peer",
	}, map[string]string{
		"publishable_key":         "pk_from_peer",
		"price_id":                "price_peer",
		"meter_event_name":        "luna_backup_gb",
		"egress_price_id":         "price_egress_peer",
		"egress_meter_event_name": "luna_backup_egress_gb",
	}, true)
	if err != nil {
		t.Fatal(err)
	}

	// Stale in-memory config until RefreshStripe.
	if config.C.Stripe.SecretKey != "sk_yaml" {
		t.Fatalf("pre-refresh secret=%q", config.C.Stripe.SecretKey)
	}

	RefreshStripe()
	if config.C.Stripe.SecretKey != "sk_from_peer" {
		t.Fatalf("secret_key=%q", config.C.Stripe.SecretKey)
	}
	if config.C.Stripe.WebhookSecret != "whsec_from_peer" {
		t.Fatalf("webhook_secret=%q", config.C.Stripe.WebhookSecret)
	}
	if config.C.Stripe.PriceID != "price_peer" {
		t.Fatalf("price_id=%q", config.C.Stripe.PriceID)
	}
	if config.C.Stripe.MeterEventName != "luna_backup_gb" {
		t.Fatalf("meter_event_name=%q", config.C.Stripe.MeterEventName)
	}
	if config.C.Stripe.EgressPriceID != "price_egress_peer" {
		t.Fatalf("egress_price_id=%q", config.C.Stripe.EgressPriceID)
	}
	if config.C.Stripe.EgressMeterEventName != "luna_backup_egress_gb" {
		t.Fatalf("egress_meter_event_name=%q", config.C.Stripe.EgressMeterEventName)
	}
	if !config.C.Stripe.Enabled {
		t.Fatal("expected enabled")
	}
}
