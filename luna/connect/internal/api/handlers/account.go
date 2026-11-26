package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stripe/stripe-go/v87"
	"golang.org/x/crypto/bcrypt"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type AccountHandler struct {
	Deps
	// Resend is optional; tests inject a mock. Production uses the default client.
	Resend *providers.ResendClient
}

const authAttemptMax = 10
const authAttemptWindow = 15 * 60

// SessionTTL is how long a signed-in Luna Connect browser session lasts.
// Matches lunad's 7-day session cap so a stolen cookie does not live a month.
const SessionTTL = 7 * 24 * time.Hour

func (h AccountHandler) CheckEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	email := strings.ToLower(strings.TrimSpace(req.Email))
	// Separate from register/login — onboarding calls this before create and must not burn that bucket.
	if !allowGuess(h.DB, "email-check:"+ClientIP(r), 60, authAttemptWindow) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
		return
	}
	if !auth.ValidEmail(email) {
		JSONError(w, http.StatusBadRequest, "Enter a valid email address.")
		return
	}
	var exists int
	err := h.DB.QueryRow(`SELECT 1 FROM accounts WHERE email = ?`, email).Scan(&exists)
	if err == nil {
		JSONError(w, http.StatusConflict, "That email already has an account. Sign in instead.")
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		JSONError(w, http.StatusInternalServerError, "Could not check that email. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"available": true})
}

func (h AccountHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	email := strings.ToLower(strings.TrimSpace(req.Email))
	ip := ClientIP(r)
	if authBlocked(h.DB, ip, email, authAttemptMax, authAttemptWindow) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
		return
	}
	if !auth.ValidEmail(email) {
		_ = allowAuthAttempt(h.DB, ip, email, authAttemptMax, authAttemptWindow)
		JSONError(w, http.StatusBadRequest, "Enter a valid email address.")
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		_ = allowAuthAttempt(h.DB, ip, email, authAttemptMax, authAttemptWindow)
		switch {
		case errors.Is(err, auth.ErrPasswordTooShort):
			JSONError(w, http.StatusBadRequest, "Passwords need at least 12 characters.")
		case errors.Is(err, auth.ErrPasswordMissingComplexity):
			JSONError(w, http.StatusBadRequest, "Passwords need at least one letter and one number.")
		default:
			JSONError(w, http.StatusBadRequest, "Choose a stronger password and try again.")
		}
		return
	}
	if msg := auth.RejectBreachedPassword(req.Password); msg != "" {
		_ = allowAuthAttempt(h.DB, ip, email, authAttemptMax, authAttemptWindow)
		JSONError(w, http.StatusBadRequest, msg)
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create the account. Try again.")
		return
	}
	// The account row comes first: signup must not depend on Stripe being up.
	// The Stripe customer is created lazily on the first billing call via
	// billing.EnsureCustomer (StartCheckout).
	id := security.NewID("acct")
	_, err = h.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES (?, ?, ?, 0, 'none', 0, ?)`, id, email, string(hash), time.Now().Unix())
	if err != nil {
		_ = allowAuthAttempt(h.DB, ip, email, authAttemptMax, authAttemptWindow)
		var exists int
		if h.DB.QueryRow(`SELECT 1 FROM accounts WHERE email = ?`, email).Scan(&exists) == nil {
			JSONError(w, http.StatusConflict, "That email already has an account. Sign in instead.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "Could not create the account. Try again.")
		return
	}
	h.setSession(w, id)
	// Best-effort verification email — registration still succeeds if mail is down.
	verificationToken, _ := h.createEmailVerificationToken(r.Context(), id)
	if verificationToken != "" {
		go h.sendVerificationEmail(email, verificationToken, "")
	}
	JSON(w, http.StatusCreated, map[string]any{
		"id": id, "email": email, "has_card": false, "email_verified": false,
		"stripe_publishable_key": stripePublishableKey(),
	})
}

func (h AccountHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	email := strings.ToLower(strings.TrimSpace(req.Email))
	ip := ClientIP(r)
	if authBlocked(h.DB, ip, email, authAttemptMax, authAttemptWindow) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
		return
	}
	// Failures are also counted per account, so rotating client addresses does
	// not reset the budget. A full bucket does not lock the owner out: the
	// password is still checked, and a correct one is let through and clears
	// the bucket. Wrong guesses get the same generic 429 either way, so the
	// answer never says whether the account exists.
	accountKey := signInAccountKey("customer", email)
	accountCapped := guessBlocked(h.DB, accountKey, signInAccountAttemptMax, signInAccountAttemptWindow)
	var id, hash string
	var emailVerified int
	err := h.DB.QueryRow(`SELECT id, password_hash, email_verified FROM accounts WHERE email = ?`, email).
		Scan(&id, &hash, &emailVerified)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		JSONError(w, http.StatusInternalServerError, "Could not sign in. Try again.")
		return
	}
	if err != nil {
		// No account for this address. Verify one password anyway, so the
		// answer takes as long as a wrong password on a real account and the
		// clock cannot be used to test whether an address is registered.
		_ = auth.VerifyDummyPassword(req.Password)
	}
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		if !accountCapped {
			_ = allowAuthAttempt(h.DB, ip, email, authAttemptMax, authAttemptWindow)
			_ = allowGuess(h.DB, accountKey, signInAccountAttemptMax, signInAccountAttemptWindow)
		}
		if accountCapped {
			JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
			return
		}
		JSONError(w, http.StatusUnauthorized, "That email or password did not match.")
		return
	}
	// Correct password while the bucket is full must still sign the owner in;
	// the cap is not a lockout. Start the count over.
	clearSignInAccountAttempts(h.DB, accountKey)
	h.setSession(w, id)
	JSON(w, http.StatusOK, map[string]any{"ok": true, "email_verified": emailVerified == 1, "email": email, "id": id})
}

func (h AccountHandler) Me(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	if acct.BillingStatus == "canceling" && acct.StripeSub != "" {
		// "Turn off payment" scheduled the end. If Stripe has ended it but
		// its webhook never arrived, finish here, or the account would show
		// "being turned off" forever.
		if status, err := billing.SubscriptionStatus(acct.StripeSub); err == nil && status == "canceled" {
			if err := finishCanceling(h.Deps, acct.ID, acct.StripeSub); err == nil {
				acct.BillingStatus, acct.StripeSub, acct.HasCard = "canceled", "", false
			}
		}
	}
	var liveBytes int64
	_ = h.DB.QueryRow(`SELECT COALESCE((SELECT SUM(size) FROM storage_packs WHERE account_id = ?), 0) + COALESCE((SELECT SUM(bytes) FROM storage_records WHERE account_id = ?), 0)`, acct.ID, acct.ID).Scan(&liveBytes)
	avgBytes, egressBytes := billing.AccountPeriodUsage(h.DB, acct.ID)
	var payStatus string
	humanVerified := false
	if err := h.DB.QueryRow(`SELECT status FROM oss_payments WHERE account_id = ?`, acct.ID).Scan(&payStatus); err == nil && payStatus == "succeeded" {
		humanVerified = true
	}
	dev := loadBoundDevice(h.DB, acct.ID)
	resolvedPath, resolvedStep := ResolveOnboarding(acct.OnboardingPath, acct.OnboardingStep, dev)
	persistOnboardingIfChanged(h.DB, acct.ID, acct.OnboardingPath, acct.OnboardingStep, resolvedPath, resolvedStep)
	status := onboardingStatusFields(resolvedPath, resolvedStep, dev)
	// Credit lives in Stripe and only shows once cloud backup is on, so only
	// those accounts pay for the Stripe call. A Stripe hiccup must not break
	// the account page: a failed read shows no credit rather than an error.
	var creditCents int64
	if acct.HasCard {
		var err error
		if creditCents, err = billing.CreditBalanceCents(acct.StripeCustomer); err != nil {
			slog.Warn("could not read credit balance from stripe", "account", acct.ID, "error", err)
			creditCents = 0
		}
	}

	payFixURL := ""
	if acct.StripeSub != "" && paymentFailedStatus(acct.BillingStatus) {
		payFixURL = paymentFixURL(acct.ID, acct.StripeSub)
	}

	JSON(w, http.StatusOK, map[string]any{
		"payment_fix_url":        payFixURL,
		"id":                     acct.ID,
		"email":                  acct.Email,
		"email_verified":         acct.EmailVerified,
		"has_card":               acct.HasCard && billing.BackupsUnlocked(acct.HasCard, acct.BillingStatus),
		"human_verified":         humanVerified,
		"billing_status":         acct.BillingStatus,
		"stored_bytes":           liveBytes,
		"avg_stored_bytes":       avgBytes,
		"egress_bytes":           egressBytes,
		"estimated_month":        billing.EstimateMonthUSD(avgBytes, egressBytes),
		"credit_balance_cents":   creditCents,
		"price_copy":             PriceCopy(),
		"backup_purge_after":     acct.BackupPurgeAfter,
		"onboarding_path":        status["path"],
		"onboarding_step":        status["step"],
		"has_bound_device":       status["has_bound_device"],
		"skip_code_entry":        status["skip_code_entry"],
		"onboarding_device_id":   status["device_id"],
		"onboarding_hostname":    status["hostname"],
		"stripe_publishable_key": stripePublishableKey(),
		"stripe_enabled":         config.Stripe().Enabled,
	})
}

func stripePublishableKey() string {
	providers.RefreshStripe()
	st := config.Stripe()
	if !st.Enabled {
		return ""
	}
	return strings.TrimSpace(st.PublishableKey)
}

func (h AccountHandler) PublicConfig(w http.ResponseWriter, r *http.Request) {
	st := config.Stripe()
	JSON(w, http.StatusOK, map[string]any{
		"stripe_publishable_key": stripePublishableKey(),
		"stripe_enabled":         st.Enabled,
	})
}

func (h AccountHandler) CancelBilling(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	message, ok := h.cancelBillingFor(w, acct)
	if !ok {
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": message,
	})
}

// cancelBillingFor turns payment off and deletes the cloud copies. On failure
// it has already written the error response and returns ok=false; on success
// the caller writes the response.
func (h AccountHandler) cancelBillingFor(w http.ResponseWriter, acct Account) (string, bool) {
	// The card only goes with the cloud copies: storage nobody pays for is never kept.
	// Bill this month so far first, then delete. Stored data or a billable month
	// means a final invoice; an account that never stored anything just stops.
	avgBytes, egressBytes := billing.AccountPeriodUsage(h.DB, acct.ID)
	stored := storageUsed(h.DB, acct.ID)
	owesThisMonth := billing.MonthMills(avgBytes, egressBytes) > 0
	var hasCard int
	var status string
	_ = h.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE id = ?`, acct.ID).Scan(&hasCard, &status)
	if status == "canceling" {
		return "Payment is already being turned off.", true
	}
	finalBill := acct.StripeSub != "" && (owesThisMonth || stored > 0)
	if finalBill {
		// Bill the month so far. Stripe needs about a minute to process the
		// usage we report now, so the subscription ends FinalChargeDelay from
		// now and Stripe bills that usage on its final invoice. Until then the
		// account stays linked as "canceling": backups are off, webhooks for
		// the subscription can't turn them back on or start a countdown, and
		// a new subscription waits (it would bill the same meters).
		if _, err := h.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = 'canceling' WHERE id = ?`, acct.ID); err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not turn off payment. Nothing was charged or deleted. Try again in a few minutes.")
			return "", false
		}
		if _, _, ok := billing.ReportAccountUsage(h.DB, acct.ID); !ok {
			slog.Warn("turn off payment: could not report this month's usage; the final bill uses the last hourly report", "account", acct.ID)
		}
		if _, err := billing.ScheduleFinalCharge(acct.StripeSub); err != nil {
			_, _ = h.DB.Exec(`UPDATE accounts SET has_card = ?, billing_status = ? WHERE id = ?`, hasCard, status, acct.ID)
			writeBillingErr(w, err, "Could not turn off payment. Nothing was charged or deleted. Try again in a few minutes.")
			return "", false
		}
		if billing.DevBypass() {
			// Local test setup: no Stripe, so no webhook will ever end it.
			if err := finishCanceling(h.Deps, acct.ID, acct.StripeSub); err != nil {
				slog.Error("turn off payment (dev): could not finish", "account", acct.ID, "error", err)
			}
		}
	} else {
		// Nothing stored and nothing owed: stop at once. Detach first, so the
		// webhooks for this cancel match no account.
		if _, err := h.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = 'canceled', stripe_subscription_id = '' WHERE id = ?`, acct.ID); err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not turn off payment. Nothing was charged or deleted. Try again in a few minutes.")
			return "", false
		}
		if err := billing.CancelSubscription(acct.StripeSub); err != nil {
			_, _ = h.DB.Exec(`UPDATE accounts SET has_card = ?, billing_status = ?, stripe_subscription_id = ? WHERE id = ?`,
				hasCard, status, acct.StripeSub, acct.ID)
			writeBillingErr(w, err, "Could not turn off payment. Nothing was charged or deleted. Try again in a few minutes.")
			return "", false
		}
	}
	message := "Payment is off."
	if finalBill {
		message = "Payment is being turned off."
	}
	if stored > 0 {
		deleteCloudCopiesNow(h.Deps, acct.ID, acct.Email)
		message += " Luna Connect is deleting your cloud backups."
	}
	return message, true
}

func writeBillingErr(w http.ResponseWriter, err error, fallback string) {
	if errors.Is(err, billing.ErrNotConfigured) {
		JSONError(w, http.StatusServiceUnavailable, "Card billing is not set up on this Luna Connect site. Contact support.")
		return
	}
	var stripeErr *stripe.Error
	if errors.As(err, &stripeErr) && stripeErr.Type == stripe.ErrorTypeCard {
		JSONError(w, http.StatusPaymentRequired, "Your bank did not accept this card. Try a different card.")
		return
	}
	JSONError(w, http.StatusBadRequest, fallback)
}

func (h AccountHandler) Usage(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var liveBytes int64
	_ = h.DB.QueryRow(`SELECT COALESCE((SELECT SUM(size) FROM storage_packs WHERE account_id = ?), 0) + COALESCE((SELECT SUM(bytes) FROM storage_records WHERE account_id = ?), 0)`, acct.ID, acct.ID).Scan(&liveBytes)
	avgBytes, egressBytes := billing.AccountPeriodUsage(h.DB, acct.ID)
	JSON(w, http.StatusOK, map[string]any{
		"stored_bytes":        liveBytes,
		"avg_stored_bytes":    avgBytes,
		"egress_bytes":        egressBytes,
		"egress_overage_gb":   billing.EgressOverageGB(avgBytes, egressBytes),
		"estimated_month_usd": billing.EstimateMonthUSD(avgBytes, egressBytes),
	})
}

func (h AccountHandler) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("luna_connect_session"); err == nil {
		_, _ = h.DB.Exec(`DELETE FROM sessions WHERE token_hash = ?`, security.HashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{
		Name: "luna_connect_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		Secure: config.CookieSecure(), SameSite: http.SameSiteLaxMode,
	})
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h AccountHandler) Devices(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	rows, err := h.DB.Query(`SELECT id, COALESCE(device_uid,''), COALESCE(state,'unbound'), COALESCE(name,''), COALESCE(subdomain,''), COALESCE(code_hint,''), COALESCE(last_seen_at,0), kind FROM devices WHERE account_id = ?`, acct.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not load this Luna.")
		return
	}
	defer rows.Close()
	now := time.Now().Unix()
	out := []map[string]any{}
	for rows.Next() {
		var id, uid, state, name, sub, hint, kind string
		var lastSeen int64
		_ = rows.Scan(&id, &uid, &state, &name, &sub, &hint, &lastSeen, &kind)
		item := map[string]any{
			"id":           id,
			"device_uid":   security.GroupCrockford(uid),
			"state":        state,
			"name":         name,
			"kind":         kind,
			"code_hint":    hint,
			"last_seen_at": lastSeen,
			"online":       state == "bound" && lastSeen > 0 && now-lastSeen <= OnlineWithinSec,
			"subdomain":    sub,
		}
		if sub != "" {
			item["hostname"] = sub + "." + config.C.Server.PublicZone
		}
		out = append(out, item)
	}
	JSON(w, http.StatusOK, map[string]any{"devices": out})
}

// revealWrongPassword is the answer when the step-up password does not match.
const revealWrongPassword = "That password is wrong. The pairing details were not shown."

// RevealDeviceCode returns the public Device ID and reusable verification code
// for a Luna on this account. The rolling credential is never returned. The
// request is a POST (so CSRF and Origin checks apply) and carries the account's
// current password; wrong passwords share sign-in's persisted limits.
func (h AccountHandler) RevealDeviceCode(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Password == "" {
		JSONError(w, http.StatusBadRequest, "Enter your password to see the pairing details.")
		return
	}
	email := strings.ToLower(strings.TrimSpace(acct.Email))
	ip := ClientIP(r)
	if authBlocked(h.DB, ip, email, authAttemptMax, authAttemptWindow) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
		return
	}
	accountKey := signInAccountKey("customer", email)
	accountCapped := guessBlocked(h.DB, accountKey, signInAccountAttemptMax, signInAccountAttemptWindow)
	var hash string
	err := h.DB.QueryRow(`SELECT password_hash FROM accounts WHERE id = ?`, acct.ID).Scan(&hash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		JSONError(w, http.StatusInternalServerError, "Could not check your password. Try again.")
		return
	}
	if err != nil {
		// The session's account row is gone. Spend the same bcrypt time as a
		// real check so the answer looks like a wrong password.
		_ = auth.VerifyDummyPassword(req.Password)
	}
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		if accountCapped {
			JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
			return
		}
		_ = allowAuthAttempt(h.DB, ip, email, authAttemptMax, authAttemptWindow)
		_ = allowGuess(h.DB, accountKey, signInAccountAttemptMax, signInAccountAttemptWindow)
		// 403, not 401: 401 means "signed out" to the web app.
		JSONError(w, http.StatusForbidden, revealWrongPassword)
		return
	}
	clearSignInAccountAttempts(h.DB, accountKey)

	id := chi.URLParam(r, "deviceID")
	var hint, sealed, uid string
	var account sql.NullString
	err = h.DB.QueryRow(`SELECT COALESCE(code_hint,''), COALESCE(verification_code_sealed,''), COALESCE(device_uid,''), account_id FROM devices WHERE id = ?`, id).Scan(&hint, &sealed, &uid, &account)
	if err != nil || !account.Valid || account.String != acct.ID {
		JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		return
	}
	if sealed == "" || uid == "" {
		JSONError(w, http.StatusConflict, "This Luna needs new pairing details from support.")
		return
	}
	code, err := security.OpenString(sealed)
	if err != nil || !security.IsVerificationCodeShape(code) {
		JSONError(w, http.StatusInternalServerError, "Could not read the pairing details. Contact support.")
		return
	}
	slog.Info("device pairing details revealed", "account_id", acct.ID, "device_id", id)
	JSON(w, http.StatusOK, map[string]any{"device_uid": security.GroupCrockford(uid), "verification_code": code, "code_hint": hint})
}

func (h AccountHandler) setSession(w http.ResponseWriter, accountID string) {
	tok := security.RandomHex(24)
	_, _ = h.DB.Exec(`INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)`,
		security.HashToken(tok), accountID, time.Now().Add(SessionTTL).Unix())
	http.SetCookie(w, &http.Cookie{
		Name:     "luna_connect_session",
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		Secure:   config.CookieSecure(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(SessionTTL.Seconds()),
	})
}

func (h AccountHandler) AccountAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("luna_connect_session")
		if err != nil {
			JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
			return
		}
		var id, email, status, cust, sub, obPath, obStep string
		var has, emailVerified int
		var purgeAfter int64
		err = h.DB.QueryRow(`
SELECT a.id, a.email, a.has_card, a.billing_status, COALESCE(a.stripe_customer_id,''), COALESCE(a.stripe_subscription_id,''), a.email_verified, COALESCE(a.backup_purge_after, 0), COALESCE(a.onboarding_path,''), COALESCE(a.onboarding_step,'')
FROM sessions s JOIN accounts a ON a.id = s.account_id
WHERE s.token_hash = ? AND s.expires_at > ?`, security.HashToken(c.Value), time.Now().Unix()).
			Scan(&id, &email, &has, &status, &cust, &sub, &emailVerified, &purgeAfter, &obPath, &obStep)
		if err != nil {
			JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
			return
		}
		next.ServeHTTP(w, r.WithContext(WithAccount(r.Context(), Account{
			ID: id, Email: email, HasCard: has == 1, BillingStatus: status,
			StripeCustomer: cust, StripeSub: sub, BackupPurgeAfter: purgeAfter, EmailVerified: emailVerified == 1,
			OnboardingPath: obPath, OnboardingStep: obStep,
		})))
	})
}
