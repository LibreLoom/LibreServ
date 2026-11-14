package handlers

import (
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

// devStripe runs billing in local dev mode, so grants and Stripe lookups
// succeed without a network call.
func devStripe(t *testing.T) {
	t.Helper()
	t.Setenv("LUNACONNECT_DEV", "1")
	prev := config.C.Stripe
	t.Cleanup(func() { config.C.Stripe = prev })
	config.C.Stripe.Enabled = false
}

func checkoutAccount(t *testing.T, d Deps, email string) string {
	t.Helper()
	registerAccount(t, AccountHandler{Deps: d}, email)
	var id string
	if err := d.DB.QueryRow(`SELECT id FROM accounts WHERE email = ?`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestFulfillCardCheckRecordsOnce(t *testing.T) {
	devStripe(t)
	d := testDeps(t)
	id := checkoutAccount(t, d, "check@b.co")
	c := billing.Checkout{ID: "cs_1", Kind: billing.CheckoutCardCheck, AccountID: id, PaymentIntent: "pi_1", Done: true}
	for i := 0; i < 2; i++ { // return page and webhook both arrive
		if err := fulfillCheckout(d, c); err != nil {
			t.Fatalf("fulfill %d: %v", i, err)
		}
	}
	if !humanVerified(d.DB, id) {
		t.Fatal("a paid card check must mark the account verified")
	}
}

func TestFulfillIgnoresUnfinishedAndForeignCheckouts(t *testing.T) {
	devStripe(t)
	d := testDeps(t)
	id := checkoutAccount(t, d, "unpaid@b.co")
	if err := fulfillCheckout(d, billing.Checkout{ID: "cs_2", Kind: billing.CheckoutCardCheck, AccountID: id}); err != nil {
		t.Fatal(err)
	}
	if humanVerified(d.DB, id) {
		t.Fatal("an unpaid checkout must not verify the account")
	}
	_, _ = d.DB.Exec(`UPDATE accounts SET stripe_customer_id = 'cus_mine' WHERE id = ?`, id)
	foreign := billing.Checkout{ID: "cs_3", Kind: billing.CheckoutCardCheck, AccountID: id, CustomerID: "cus_someone_else", Done: true}
	if err := fulfillCheckout(d, foreign); err != nil {
		t.Fatal(err)
	}
	if humanVerified(d.DB, id) {
		t.Fatal("a checkout paid by another Stripe customer must not verify this account")
	}
}

func TestFulfillBackupClaimsSubscriptionAndFinishesOnboarding(t *testing.T) {
	devStripe(t)
	d := testDeps(t)
	id := checkoutAccount(t, d, "sub@b.co")
	_, _ = d.DB.Exec(`UPDATE accounts SET onboarding_step = 'backup', backup_purge_after = 123 WHERE id = ?`, id)
	c := billing.Checkout{ID: "cs_4", Kind: billing.CheckoutBackup, AccountID: id, SubscriptionID: "sub_new", From: "onboarding", Done: true}
	if err := fulfillCheckout(d, c); err != nil {
		t.Fatal(err)
	}
	var has int
	var status, sub, step string
	var purge int64
	_ = d.DB.QueryRow(`SELECT has_card, billing_status, stripe_subscription_id, onboarding_step, COALESCE(backup_purge_after, 0) FROM accounts WHERE id = ?`, id).
		Scan(&has, &status, &sub, &step, &purge)
	if has != 1 || status != "active" || sub != "sub_new" || step != "done" || purge != 0 {
		t.Fatalf("after checkout: has=%d status=%s sub=%s step=%s purge=%d", has, status, sub, step, purge)
	}
}

func TestFulfillBackupNeverReplacesAnExistingSubscription(t *testing.T) {
	devStripe(t)
	d := testDeps(t)
	id := checkoutAccount(t, d, "twice@b.co")
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active', stripe_subscription_id = 'sub_first' WHERE id = ?`, id)
	c := billing.Checkout{ID: "cs_5", Kind: billing.CheckoutBackup, AccountID: id, SubscriptionID: "sub_second", From: "backups", Done: true}
	if err := fulfillCheckout(d, c); err != nil {
		t.Fatal(err)
	}
	var sub string
	_ = d.DB.QueryRow(`SELECT stripe_subscription_id FROM accounts WHERE id = ?`, id).Scan(&sub)
	if sub != "sub_first" {
		t.Fatalf("a second subscription must never replace the first (double billing): got %s", sub)
	}
}

func TestCheckoutURLs(t *testing.T) {
	prev := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = prev })
	config.C.Server.BaseURL = "https://connect.example/"
	ok, back := checkoutURLs("diyonboarding", billing.CheckoutCardCheck)
	if ok != "https://connect.example/diyonboarding?step=card&checkout={CHECKOUT_SESSION_ID}" || back != "https://connect.example/diyonboarding?step=card" {
		t.Fatalf("card check urls: %s | %s", ok, back)
	}
	ok, back = checkoutURLs("backups", billing.CheckoutBackup)
	if ok != "https://connect.example/backups?checkout={CHECKOUT_SESSION_ID}" || back != "https://connect.example/backups" {
		t.Fatalf("backups urls: %s | %s", ok, back)
	}
	if ok, _ = checkoutURLs("onboarding", billing.CheckoutBackup); !strings.Contains(ok, "/onboarding?step=backup&") {
		t.Fatalf("onboarding backup url: %s", ok)
	}
}
