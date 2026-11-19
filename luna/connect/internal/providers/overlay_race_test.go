package providers

import (
	"sync"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

// Two connections saved at the same time — and the requests that read the
// overlay while they are saved — must not tear the settings or lose either
// write. The overlay is replaced as one value, and Update merges the stored
// credentials instead of overwriting them.
func TestConcurrentProviderOverlaysKeepBothSettings(t *testing.T) {
	db := testDB(t)

	prevStripe, prevCloudflare := config.Stripe(), config.Cloudflare()
	t.Cleanup(func() {
		config.SetStripe(prevStripe)
		config.SetCloudflare(prevCloudflare)
		SetStripeRuntimeDB(nil)
		SetCloudflareRuntimeDB(nil)
		CaptureStripeBase()
		CaptureCloudflareBase()
	})
	config.SetStripe(config.StripeConfig{})
	config.SetCloudflare(config.CloudflareConfig{})
	CaptureStripeBase()
	CaptureCloudflareBase()
	SetStripeRuntimeDB(db)
	SetCloudflareRuntimeDB(db)

	svc := NewService(db)
	stripeP, err := svc.Create("stripe", "Stripe",
		map[string]string{"secret_key": "sk_one", "webhook_secret": "whsec_one"},
		map[string]string{"publishable_key": "pk_one", "price_id": "price_one"}, true)
	if err != nil {
		t.Fatal(err)
	}
	cfP, err := svc.Create("cloudflare", "Cloudflare",
		map[string]string{"account_id": "account_one", "api_token": "token_one"},
		map[string]string{"zone_id": "zone_one"}, true)
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < 25; i++ {
			_ = ApplyStripeFromDB(db)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 25; i++ {
			_ = ApplyCloudflareFromDB(db)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 25; i++ {
			st := config.Stripe()
			if st.SecretKey == "sk_one" && st.PublishableKey != "pk_one" {
				t.Errorf("torn Stripe settings: %+v", st)
				return
			}
			cf := config.Cloudflare()
			if cf.AccountID == "account_one" && cf.APIToken != "token_one" {
				t.Errorf("torn Cloudflare settings: %+v", cf)
				return
			}
		}
	}()
	wg.Wait()

	if st := config.Stripe(); st.SecretKey != "sk_one" || st.PublishableKey != "pk_one" {
		t.Fatalf("stripe overlay = %+v", st)
	}
	if cf := config.Cloudflare(); cf.AccountID != "account_one" || cf.APIToken != "token_one" {
		t.Fatalf("cloudflare overlay = %+v", cf)
	}

	// Two saves on different connections at once, each leaving the stored
	// secrets alone. Both must keep the secret they did not resend.
	var saves sync.WaitGroup
	saves.Add(2)
	go func() {
		defer saves.Done()
		if err := svc.Update(stripeP.ID, "stripe", "Stripe",
			map[string]string{"secret_key": ""},
			map[string]string{"publishable_key": "pk_two", "price_id": "price_two"}, true); err != nil {
			t.Errorf("stripe update: %v", err)
		}
	}()
	go func() {
		defer saves.Done()
		if err := svc.Update(cfP.ID, "cloudflare", "Cloudflare",
			map[string]string{"api_token": ""},
			map[string]string{"zone_id": "zone_two"}, true); err != nil {
			t.Errorf("cloudflare update: %v", err)
		}
	}()
	saves.Wait()

	gotStripe, err := svc.Get(stripeP.ID)
	if err != nil || gotStripe == nil {
		t.Fatalf("read stripe: %v", err)
	}
	if gotStripe.Credential("secret_key", "") != "sk_one" || gotStripe.Credential("webhook_secret", "") != "whsec_one" {
		t.Fatalf("stripe credentials lost: %+v", gotStripe.Credentials)
	}
	if gotStripe.Setting("publishable_key", "") != "pk_two" {
		t.Fatalf("stripe settings not saved: %+v", gotStripe.Settings)
	}

	gotCF, err := svc.Get(cfP.ID)
	if err != nil || gotCF == nil {
		t.Fatalf("read cloudflare: %v", err)
	}
	if gotCF.Credential("account_id", "") != "account_one" || gotCF.Credential("api_token", "") != "token_one" {
		t.Fatalf("cloudflare credentials lost: %+v", gotCF.Credentials)
	}
	if gotCF.Setting("zone_id", "") != "zone_two" {
		t.Fatalf("cloudflare settings not saved: %+v", gotCF.Settings)
	}
}
