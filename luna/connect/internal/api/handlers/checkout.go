package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

// Payments go through Stripe Checkout with Managed Payments on: Stripe hosts
// the payment page, adds tax, and sends the person back here with
// ?checkout=<session id>. The page then calls CompleteCheckout, and Stripe's
// checkout.session.* webhook does the same work. Whichever arrives first
// finishes the checkout; fulfillCheckout is safe to run twice.

// LinkManageURL is where customers update the card for a Managed Payments
// subscription: Stripe sells it through Link, and the API cannot change it.
const LinkManageURL = "https://app.link.com"

// checkoutReturnPages are the pages a checkout may return to, with the
// onboarding step to resume on.
var checkoutReturnPages = map[string]string{
	"onboarding":    "/onboarding",
	"diyonboarding": "/diyonboarding",
	"backups":       "/backups",
}

func checkoutURLs(from, kind string) (success, cancel string) {
	base := strings.TrimRight(strings.TrimSpace(config.C.Server.BaseURL), "/")
	page := base + checkoutReturnPages[from]
	query := ""
	if from != "backups" {
		step := "backup"
		if kind == billing.CheckoutCardCheck {
			step = "card"
		}
		query = "step=" + step
	}
	cancel = page
	if query != "" {
		cancel += "?" + query
		return cancel + "&checkout={CHECKOUT_SESSION_ID}", cancel
	}
	return page + "?checkout={CHECKOUT_SESSION_ID}", cancel
}

func humanVerified(db interface {
	QueryRow(string, ...any) *sql.Row
}, accountID string) bool {
	var status string
	err := db.QueryRow(`SELECT status FROM oss_payments WHERE account_id = ?`, accountID).Scan(&status)
	return err == nil && status == "succeeded"
}

// StartCheckout opens a Stripe payment page: the one-time $1 card check
// ("card_check") or monthly cloud backup ("backup"). It answers
// {checkout_url} to send the browser to, or {done: true} when there is nothing
// to pay (already done, or local dev without Stripe).
func (h AccountHandler) StartCheckout(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var req struct {
		Kind     string `json:"kind"`
		ReturnTo string `json:"return_to"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	kind := strings.TrimSpace(req.Kind)
	from := strings.TrimSpace(req.ReturnTo)
	if _, ok := checkoutReturnPages[from]; !ok || (kind != billing.CheckoutCardCheck && kind != billing.CheckoutBackup) {
		JSONError(w, http.StatusBadRequest, "Could not tell what to pay for. Reload the page and try again.")
		return
	}
	failMsg := "Could not open the payment page. Try again in a few minutes."
	switch kind {
	case billing.CheckoutCardCheck:
		if humanVerified(h.DB, acct.ID) {
			JSON(w, http.StatusOK, map[string]any{"ok": true, "done": true})
			return
		}
		if billing.DevBypass() {
			markCardChecked(h.Deps, acct.ID, "pi_dev_verify_"+acct.ID)
			JSON(w, http.StatusOK, map[string]any{"ok": true, "done": true, "dev": true})
			return
		}
		failMsg = "Could not open the $1 card check. Try again in a few minutes."
	case billing.CheckoutBackup:
		if acct.StripeSub != "" && acct.BillingStatus == "canceling" {
			// "Turn off payment" scheduled the old subscription to end. A new
			// one before then would bill the same meters twice. If it has
			// ended and the webhook never came, finish it here.
			status, err := billing.SubscriptionStatus(acct.StripeSub)
			if err != nil {
				writeBillingErr(w, err, "Could not check your last cloud backup payment. Try again in a few minutes.")
				return
			}
			if status != "canceled" {
				JSONError(w, http.StatusConflict, "Payment is still being turned off. Try again in about 10 minutes.")
				return
			}
			if err := finishCanceling(h.Deps, acct.ID, acct.StripeSub); err != nil {
				JSONError(w, http.StatusInternalServerError, failMsg)
				return
			}
			acct.StripeSub = ""
		}
		if acct.StripeSub != "" {
			if billing.BackupsUnlocked(true, acct.BillingStatus) {
				JSON(w, http.StatusOK, map[string]any{"ok": true, "done": true, "already_active": true})
				return
			}
			// A second subscription would bill the same storage twice. The
			// existing one is waiting on a failed payment, which the card
			// update on Link fixes.
			JSON(w, http.StatusConflict, map[string]any{
				"error":      "Your last cloud backup payment didn't go through. Update your card at link.com, where Stripe keeps it for cloud backup.",
				"manage_url": LinkManageURL,
			})
			return
		}
		if billing.DevBypass() {
			_, _ = h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'dev', stripe_subscription_id = 'sub_dev', backup_purge_after = NULL, purge_mail_day = NULL WHERE id = ?`, acct.ID)
			if from != "backups" {
				_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_step = 'done' WHERE id = ?`, acct.ID)
			}
			JSON(w, http.StatusOK, map[string]any{"ok": true, "done": true, "dev": true})
			return
		}
		failMsg = "Could not open the cloud backup payment page. Try again in a few minutes."
	}
	cust, err := billing.EnsureCustomer(acct.Email, acct.StripeCustomer)
	if err != nil {
		writeBillingErr(w, err, failMsg)
		return
	}
	if cust != acct.StripeCustomer {
		if _, err := h.DB.Exec(`UPDATE accounts SET stripe_customer_id = ? WHERE id = ?`, cust, acct.ID); err != nil {
			slog.Error("checkout: could not save the stripe customer id", "account", acct.ID, "error", err)
			JSONError(w, http.StatusInternalServerError, failMsg)
			return
		}
	}
	success, cancel := checkoutURLs(from, kind)
	var url string
	if kind == billing.CheckoutCardCheck {
		url, err = billing.StartCardCheck(cust, acct.ID, from, success, cancel)
	} else {
		url, err = billing.StartBackupCheckout(cust, acct.ID, from, success, cancel)
	}
	if err != nil {
		slog.Error("checkout: could not create a stripe checkout session", "account", acct.ID, "kind", kind, "error", err)
		writeBillingErr(w, err, failMsg)
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "checkout_url": url})
}

// CompleteCheckout finishes a checkout when Stripe sends the person back. It
// answers {done: false} while the payment is still processing (some local
// payment methods take a while); the webhook finishes it then.
func (h AccountHandler) CompleteCheckout(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var req struct {
		SessionID string `json:"session_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	id := strings.TrimSpace(req.SessionID)
	if !strings.HasPrefix(id, "cs_") {
		JSONError(w, http.StatusBadRequest, "That payment link is not valid. Start again from this page.")
		return
	}
	if billing.DevBypass() {
		JSON(w, http.StatusOK, map[string]any{"ok": true, "done": true})
		return
	}
	c, err := billing.GetCheckout(id)
	if err != nil {
		slog.Warn("checkout: could not read session", "account", acct.ID, "session", id, "error", err)
		writeBillingErr(w, err, "Could not check that payment with Stripe. Reload the page in a minute.")
		return
	}
	if c.AccountID != acct.ID {
		JSONError(w, http.StatusNotFound, "That payment belongs to a different account.")
		return
	}
	if !c.Done {
		JSON(w, http.StatusOK, map[string]any{"ok": true, "done": false, "kind": c.Kind})
		return
	}
	if err := fulfillCheckout(h.Deps, c); err != nil {
		slog.Error("checkout: could not finish", "account", acct.ID, "session", id, "error", err)
		JSONError(w, http.StatusInternalServerError, "Your payment went through, but Luna Connect could not record it yet. Reload the page in a minute.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "done": true, "kind": c.Kind})
}

// fulfillCheckout records a finished checkout. Both the return page and the
// webhook call it, in either order and more than once, so every step is
// idempotent. An error means "try again later" (the webhook answers 500 and
// Stripe retries).
func fulfillCheckout(deps Deps, c billing.Checkout) error {
	if !c.Done || c.AccountID == "" {
		return nil
	}
	var cust, sub string
	err := deps.DB.QueryRow(`SELECT COALESCE(stripe_customer_id, ''), COALESCE(stripe_subscription_id, '') FROM accounts WHERE id = ?`, c.AccountID).Scan(&cust, &sub)
	if errors.Is(err, sql.ErrNoRows) {
		slog.Warn("checkout finished for an account that no longer exists", "account", c.AccountID, "session", c.ID)
		return nil
	}
	if err != nil {
		return err
	}
	if c.CustomerID != "" && c.CustomerID != cust {
		slog.Warn("checkout customer does not match the account; ignoring", "account", c.AccountID, "session", c.ID, "customer", c.CustomerID)
		return nil
	}
	switch c.Kind {
	case billing.CheckoutCardCheck:
		if humanVerified(deps.DB, c.AccountID) {
			return nil
		}
		// Grant before recording: a failed grant leaves the check unrecorded,
		// so the retry grants again. The idempotency key keeps that to one $1.
		if err := billing.GrantCredit(cust, billing.CardCheckCents, billing.CreditPaid, "Card check", "luna-card-check-"+c.ID); err != nil {
			return err
		}
		return markCardChecked(deps, c.AccountID, c.PaymentIntent)
	case billing.CheckoutBackup:
		return claimSubscription(deps, c, sub)
	}
	return nil
}

func markCardChecked(deps Deps, accountID, paymentIntent string) error {
	_, err := deps.DB.Exec(`INSERT INTO oss_payments (account_id, payment_intent_id, status, created_at) VALUES (?, ?, 'succeeded', ?)
ON CONFLICT(account_id) DO UPDATE SET payment_intent_id = excluded.payment_intent_id, status = 'succeeded'`,
		accountID, paymentIntent, time.Now().Unix())
	return err
}

// cancelExtraSubscription cancels a subscription that lost the claim. A
// variable so tests can see whether it was called.
var cancelExtraSubscription = billing.CancelSubscription

// claimSubscription stores a new cloud backup subscription on the account.
// Only one subscription per account may exist: usage is reported per Stripe
// customer, so a second one would bill the same storage twice. A checkout
// that loses that race (or opens a second page) has its subscription cancelled.
func claimSubscription(deps Deps, c billing.Checkout, stored string) error {
	if c.SubscriptionID == "" || stored == c.SubscriptionID {
		return nil
	}
	status, err := billing.SubscriptionStatus(c.SubscriptionID)
	if err != nil {
		return err
	}
	// An old return link or a late webhook for a subscription that has since
	// ended must not turn backups back on.
	if status == "canceled" || status == "incomplete_expired" {
		return nil
	}
	unlocked := 0
	if status == "active" || status == "trialing" {
		unlocked = 1
	}
	onboarding := ""
	if c.From == "onboarding" || c.From == "diyonboarding" {
		onboarding = ", onboarding_step = 'done'"
	}
	res, err := deps.DB.Exec(`UPDATE accounts SET has_card = ?, billing_status = ?, stripe_subscription_id = ?, backup_purge_after = NULL, purge_mail_day = NULL`+onboarding+`
WHERE id = ? AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '' OR stripe_subscription_id = ?)`,
		unlocked, status, c.SubscriptionID, c.AccountID, c.SubscriptionID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// The return page and the webhook race for the same checkout: when the
		// other one already stored this very subscription, it is not extra.
		var now string
		if err := deps.DB.QueryRow(`SELECT COALESCE(stripe_subscription_id, '') FROM accounts WHERE id = ?`, c.AccountID).Scan(&now); err != nil {
			return err
		}
		if now == c.SubscriptionID {
			return nil
		}
		slog.Warn("account already has a cloud backup subscription; cancelling the extra one", "account", c.AccountID, "kept", now, "cancelled", c.SubscriptionID)
		if err := cancelExtraSubscription(c.SubscriptionID); err != nil {
			slog.Error("could not cancel an extra subscription; cancel it in Stripe or the customer is billed twice", "account", c.AccountID, "subscription", c.SubscriptionID, "error", err)
		}
	}
	return nil
}
