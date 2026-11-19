package providers

import (
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"strings"
	"sync"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

var (
	cloudflareBaseMu sync.Mutex
	cloudflareBase   *config.CloudflareConfig

	cloudflareRuntimeMu sync.Mutex
	cloudflareRuntimeDB *database.DB

	// cloudflareApplyMu serializes overlay refreshes: each one reads the
	// provider row and publishes the result, so an older refresh must not
	// overwrite a newer one.
	cloudflareApplyMu sync.Mutex
)

// CaptureCloudflareBase stores yaml/env Cloudflare settings so admin DB overlays
// can be cleared without a process restart.
func CaptureCloudflareBase() {
	cloudflareBaseMu.Lock()
	defer cloudflareBaseMu.Unlock()
	cp := config.Cloudflare()
	cloudflareBase = &cp
}

// SetCloudflareRuntimeDB registers the shared DB used by RefreshCloudflare so every
// blue/green instance reloads Admin → Connections Cloudflare keys before use.
func SetCloudflareRuntimeDB(db *database.DB) {
	cloudflareRuntimeMu.Lock()
	defer cloudflareRuntimeMu.Unlock()
	cloudflareRuntimeDB = db
}

// RefreshCloudflare reloads Cloudflare config from the database onto this process.
// Call before tunnel/DNS operations so peers stay consistent after another
// instance updates Admin → Connections.
func RefreshCloudflare() {
	cloudflareRuntimeMu.Lock()
	db := cloudflareRuntimeDB
	cloudflareRuntimeMu.Unlock()
	if db == nil {
		return
	}
	_ = ApplyCloudflareFromDB(db)
}

// ApplyCloudflareFromDB overlays an enabled Cloudflare provider from the database
// onto the in-memory config. Starts from the captured yaml/env base when available.
// Call after migrate and after admin Cloudflare mutations.
//
// The new settings are built as one value and published once, so a tunnel or DNS
// call reading them at the same moment never sees a mixture of old and new keys.
func ApplyCloudflareFromDB(db *database.DB) error {
	cloudflareApplyMu.Lock()
	defer cloudflareApplyMu.Unlock()
	out := config.Cloudflare()
	cloudflareBaseMu.Lock()
	base := cloudflareBase
	cloudflareBaseMu.Unlock()
	if base != nil {
		out = *base
	}

	if db == nil {
		config.SetCloudflare(out)
		return nil
	}
	svc := NewService(db)
	p, err := svc.FindEnabled("cloudflare")
	if err != nil {
		config.SetCloudflare(out)
		return err
	}
	if p == nil || !p.Enabled {
		config.SetCloudflare(out)
		return nil
	}
	if aid := strings.TrimSpace(p.Credential("account_id", "")); aid != "" {
		out.AccountID = aid
	}
	if tok := strings.TrimSpace(p.Credential("api_token", "")); tok != "" {
		out.APIToken = tok
	}
	if zid := strings.TrimSpace(p.Setting("zone_id", "")); zid != "" {
		out.ZoneID = zid
	}
	config.SetCloudflare(out)
	return nil
}

// CloudflareProviderReady reports whether a provider row has tunnel + DNS fields.
func CloudflareProviderReady(p *Provider) bool {
	if p == nil {
		return false
	}
	return strings.TrimSpace(p.Credential("account_id", "")) != "" &&
		strings.TrimSpace(p.Credential("api_token", "")) != "" &&
		strings.TrimSpace(p.Setting("zone_id", "")) != ""
}
