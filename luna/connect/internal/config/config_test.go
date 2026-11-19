package config

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestLoadFromExample(t *testing.T) {
	// Prefer the example shipped in-repo; fall back to a minimal temp file.
	candidates := []string{
		filepath.Join("..", "..", "configs", "luna-connect.yaml.example"),
		filepath.Join("..", "..", "configs", "luna-connect.yaml"),
	}
	path := ""
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			path = c
			break
		}
	}
	if path == "" {
		dir := t.TempDir()
		path = filepath.Join(dir, "cfg.yaml")
		content := []byte("server:\n  port: 8099\n  base_url: http://localhost:8099\n")
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := Load(path); err != nil {
		// Example may be incomplete for required fields; still exercise setDefaults path.
		_ = err
	}
	if C.Server.Port == 0 {
		t.Fatal("expected default or loaded port")
	}
}

func TestReadyHelpers(t *testing.T) {
	if (CloudflareConfig{}).Ready() {
		t.Fatal("empty cloudflare should not be ready")
	}
	if !(CloudflareConfig{AccountID: "a", APIToken: "t", ZoneID: "z"}).Ready() {
		t.Fatal("expected cloudflare ready")
	}
	if (StripeConfig{SecretKey: "sk"}).Ready() {
		t.Fatal("stripe disabled should not be ready")
	}
	if !(StripeConfig{Enabled: true, SecretKey: "sk"}).Ready() {
		t.Fatal("expected stripe ready")
	}
}

func TestDevModeAndCookieSecure(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "")
	if DevMode() {
		t.Fatal("expected DevMode false")
	}
	t.Setenv("LUNACONNECT_DEV", "1")
	if !DevMode() {
		t.Fatal("expected DevMode true")
	}
	orig := C.Server.BaseURL
	t.Cleanup(func() { C.Server.BaseURL = orig })
	C.Server.BaseURL = "https://example.com"
	if !CookieSecure() {
		t.Fatal("https should be secure")
	}
	C.Server.BaseURL = "http://localhost"
	if CookieSecure() {
		t.Fatal("http should not be secure")
	}
}

// Requests read the Stripe and Cloudflare settings on every webhook, checkout,
// tunnel and DNS call while Admin → Connections may rewrite them. A reader must
// see one complete set, never a mixture of the old and the new one.
func TestSettingsSnapshotsAreNeverTorn(t *testing.T) {
	prevStripe, prevCloudflare := Stripe(), Cloudflare()
	t.Cleanup(func() {
		SetStripe(prevStripe)
		SetCloudflare(prevCloudflare)
	})

	first := StripeConfig{
		SecretKey: "sk_first", PublishableKey: "pk_first", WebhookSecret: "whsec_first",
		PriceID: "price_first", MeterEventName: "meter_first", Enabled: true,
	}
	second := StripeConfig{
		SecretKey: "sk_second", PublishableKey: "pk_second", WebhookSecret: "whsec_second",
		PriceID: "price_second", MeterEventName: "meter_second", Enabled: true,
	}
	firstCF := CloudflareConfig{AccountID: "account_first", APIToken: "token_first", ZoneID: "zone_first"}
	secondCF := CloudflareConfig{AccountID: "account_second", APIToken: "token_second", ZoneID: "zone_second"}
	SetStripe(first)
	SetCloudflare(firstCF)

	var wg sync.WaitGroup
	wg.Add(4)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			SetStripe(second)
			SetStripe(first)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			SetCloudflare(secondCF)
			SetCloudflare(firstCF)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			got := Stripe()
			switch got.SecretKey {
			case first.SecretKey:
				if got.PublishableKey != first.PublishableKey || got.PriceID != first.PriceID || got.WebhookSecret != first.WebhookSecret {
					t.Errorf("torn Stripe settings: %+v", got)
					return
				}
			case second.SecretKey:
				if got.PublishableKey != second.PublishableKey || got.PriceID != second.PriceID || got.WebhookSecret != second.WebhookSecret {
					t.Errorf("torn Stripe settings: %+v", got)
					return
				}
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			got := Cloudflare()
			switch got.AccountID {
			case firstCF.AccountID:
				if got.APIToken != firstCF.APIToken || got.ZoneID != firstCF.ZoneID {
					t.Errorf("torn Cloudflare settings: %+v", got)
					return
				}
			case secondCF.AccountID:
				if got.APIToken != secondCF.APIToken || got.ZoneID != secondCF.ZoneID {
					t.Errorf("torn Cloudflare settings: %+v", got)
					return
				}
			}
		}
	}()
	wg.Wait()
}

// Existing deployments keep their yaml unchanged, so the proxy list must be
// settable with only the environment variable.
func TestTrustedProxiesFromEnv(t *testing.T) {
	prev := C
	t.Cleanup(func() { C = prev })

	path := filepath.Join(t.TempDir(), "cfg.yaml")
	if err := os.WriteFile(path, []byte("server:\n  port: 8099\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LUNACONNECT_TRUSTED_PROXIES", "10.0.0.5, 172.17.0.0/16")
	if err := Load(path); err != nil {
		t.Fatal(err)
	}
	if C.TrustedProxies != "10.0.0.5, 172.17.0.0/16" {
		t.Fatalf("trusted proxies = %q", C.TrustedProxies)
	}
}
