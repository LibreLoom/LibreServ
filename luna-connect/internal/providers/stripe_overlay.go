package providers

import (
	"database/sql"
	"strings"
	"sync"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

var (
	stripeBaseMu sync.Mutex
	stripeBase   *config.StripeConfig

	stripeRuntimeMu sync.Mutex
	stripeRuntimeDB *sql.DB
)

// CaptureStripeBase stores the yaml/env Stripe settings so admin DB overlays
// can be cleared without a process restart.
func CaptureStripeBase() {
	stripeBaseMu.Lock()
	defer stripeBaseMu.Unlock()
	cp := config.C.Stripe
	stripeBase = &cp
}

// SetStripeRuntimeDB registers the shared DB used by RefreshStripe so every
// blue/green instance reloads Admin → Connections Stripe keys before use.
func SetStripeRuntimeDB(db *sql.DB) {
	stripeRuntimeMu.Lock()
	defer stripeRuntimeMu.Unlock()
	stripeRuntimeDB = db
}

// RefreshStripe reloads Stripe config from the database onto this process.
// Call before webhook verification and Stripe API use so peers stay consistent
// after another instance updates Admin → Connections.
func RefreshStripe() {
	stripeRuntimeMu.Lock()
	db := stripeRuntimeDB
	stripeRuntimeMu.Unlock()
	if db == nil {
		return
	}
	_ = ApplyStripeFromDB(db)
}

// ApplyStripeFromDB overlays an enabled Stripe provider from the database onto
// the in-memory config. Starts from the captured yaml/env base when available.
// Call after migrate and after admin Stripe mutations.
func ApplyStripeFromDB(db *sql.DB) error {
	stripeBaseMu.Lock()
	base := stripeBase
	stripeBaseMu.Unlock()
	if base != nil {
		config.C.Stripe = *base
	}

	if db == nil {
		return nil
	}
	svc := NewService(db)
	p, err := svc.FindEnabled("stripe")
	if err != nil {
		return err
	}
	if p == nil {
		return nil
	}
	if sk := strings.TrimSpace(p.Credential("secret_key", "")); sk != "" {
		config.C.Stripe.SecretKey = sk
	}
	if wh := strings.TrimSpace(p.Credential("webhook_secret", "")); wh != "" {
		config.C.Stripe.WebhookSecret = wh
	}
	if pk := strings.TrimSpace(p.Setting("publishable_key", "")); pk != "" {
		config.C.Stripe.PublishableKey = pk
	}
	if price := strings.TrimSpace(p.Setting("price_id", "")); price != "" {
		config.C.Stripe.PriceID = price
	}
	if meter := strings.TrimSpace(p.Setting("meter_event_name", "")); meter != "" {
		config.C.Stripe.MeterEventName = meter
	}
	if egressPrice := strings.TrimSpace(p.Setting("egress_price_id", "")); egressPrice != "" {
		config.C.Stripe.EgressPriceID = egressPrice
	}
	if egressMeter := strings.TrimSpace(p.Setting("egress_meter_event_name", "")); egressMeter != "" {
		config.C.Stripe.EgressMeterEventName = egressMeter
	}
	config.C.Stripe.Enabled = p.Enabled
	return nil
}
