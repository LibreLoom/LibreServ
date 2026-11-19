package providers

import (
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"strings"
	"sync"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

var (
	stripeBaseMu sync.Mutex
	stripeBase   *config.StripeConfig

	stripeRuntimeMu sync.Mutex
	stripeRuntimeDB *database.DB

	// stripeApplyMu serializes overlay refreshes: each one reads the provider
	// row and publishes the result, so an older refresh must not overwrite a
	// newer one.
	stripeApplyMu sync.Mutex
)

// CaptureStripeBase stores the yaml/env Stripe settings so admin DB overlays
// can be cleared without a process restart.
func CaptureStripeBase() {
	stripeBaseMu.Lock()
	defer stripeBaseMu.Unlock()
	cp := config.Stripe()
	stripeBase = &cp
}

// SetStripeRuntimeDB registers the shared DB used by RefreshStripe so every
// blue/green instance reloads Admin → Connections Stripe keys before use.
func SetStripeRuntimeDB(db *database.DB) {
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
//
// The new settings are built as one value and published once, so a request
// reading them at the same moment sees either the whole old set or the whole
// new set — never a mixture.
func ApplyStripeFromDB(db *database.DB) error {
	stripeApplyMu.Lock()
	defer stripeApplyMu.Unlock()
	out := config.Stripe()
	stripeBaseMu.Lock()
	base := stripeBase
	stripeBaseMu.Unlock()
	if base != nil {
		out = *base
	}

	if db == nil {
		config.SetStripe(out)
		return nil
	}
	svc := NewService(db)
	p, err := svc.FindEnabled("stripe")
	if err != nil {
		config.SetStripe(out)
		return err
	}
	if p == nil {
		config.SetStripe(out)
		return nil
	}
	if sk := strings.TrimSpace(p.Credential("secret_key", "")); sk != "" {
		// Reject misplaced Dashboard IDs (e.g. price_…) so we never send them as the API key.
		if strings.HasPrefix(sk, "sk_") {
			out.SecretKey = sk
		}
	}
	if wh := strings.TrimSpace(p.Credential("webhook_secret", "")); wh != "" {
		if strings.HasPrefix(wh, "whsec_") {
			out.WebhookSecret = wh
		}
	}
	if pk := strings.TrimSpace(p.Setting("publishable_key", "")); pk != "" {
		if strings.HasPrefix(pk, "pk_") {
			out.PublishableKey = pk
		}
	}
	if price := strings.TrimSpace(p.Setting("price_id", "")); price != "" {
		if strings.HasPrefix(price, "price_") {
			out.PriceID = price
		}
	}
	if meter := strings.TrimSpace(p.Setting("meter_event_name", "")); meter != "" {
		out.MeterEventName = meter
	}
	if egressPrice := strings.TrimSpace(p.Setting("egress_price_id", "")); egressPrice != "" {
		out.EgressPriceID = egressPrice
	}
	if egressMeter := strings.TrimSpace(p.Setting("egress_meter_event_name", "")); egressMeter != "" {
		out.EgressMeterEventName = egressMeter
	}
	out.Enabled = p.Enabled
	config.SetStripe(out)
	return nil
}
