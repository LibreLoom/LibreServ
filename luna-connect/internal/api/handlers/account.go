package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
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
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create the account. Try again.")
		return
	}
	cust, err := billing.CreateCustomer(email)
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Could not start billing. Try again in a few minutes.")
		return
	}
	id := security.NewID("acct")
	_, err = h.DB.Exec(`INSERT INTO accounts (id, email, password_hash, stripe_customer_id, has_card, billing_status, email_verified, created_at)
VALUES (?, ?, ?, ?, 0, 'none', 0, ?)`, id, email, string(hash), cust, time.Now().Unix())
	if err != nil {
		_ = allowAuthAttempt(h.DB, ip, email, authAttemptMax, authAttemptWindow)
		JSONError(w, http.StatusConflict, "That email already has an account. Sign in instead.")
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
	var id, hash string
	var emailVerified int
	err := h.DB.QueryRow(`SELECT id, password_hash, email_verified FROM accounts WHERE email = ?`, email).
		Scan(&id, &hash, &emailVerified)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		_ = allowAuthAttempt(h.DB, ip, email, authAttemptMax, authAttemptWindow)
		JSONError(w, http.StatusUnauthorized, "That email or password did not match.")
		return
	}
	h.setSession(w, id)
	JSON(w, http.StatusOK, map[string]any{"ok": true, "email_verified": emailVerified == 1, "email": email, "id": id})
}

func (h AccountHandler) Me(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var liveBytes int64
	_ = h.DB.QueryRow(`SELECT COALESCE(SUM(size),0) FROM backup_objects WHERE account_id = ?`, acct.ID).Scan(&liveBytes)
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

	JSON(w, http.StatusOK, map[string]any{
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
		"price_copy":             "Cloud backup costs $8 per terabyte each month, based on your average storage over the month. Downloads are free up to three times that average; extra download traffic is $0.01 per GB.",
		"backup_purge_after":     acct.BackupPurgeAfter,
		"onboarding_path":        status["path"],
		"onboarding_step":        status["step"],
		"has_bound_device":       status["has_bound_device"],
		"skip_code_entry":        status["skip_code_entry"],
		"onboarding_device_id":   status["device_id"],
		"onboarding_hostname":    status["hostname"],
		"stripe_publishable_key": stripePublishableKey(),
		"stripe_enabled":         config.C.Stripe.Enabled,
	})
}

func stripePublishableKey() string {
	providers.RefreshStripe()
	if !config.C.Stripe.Enabled {
		return ""
	}
	return strings.TrimSpace(config.C.Stripe.PublishableKey)
}

func (h AccountHandler) PublicConfig(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, map[string]any{
		"stripe_publishable_key": stripePublishableKey(),
		"stripe_enabled":         config.C.Stripe.Enabled,
	})
}

func paymentMethodFromJSON(body []byte) string {
	var req struct {
		PaymentMethod   string `json:"payment_method"`
		PaymentMethodID string `json:"payment_method_id"`
	}
	_ = json.Unmarshal(body, &req)
	pm := strings.TrimSpace(req.PaymentMethod)
	if pm == "" {
		pm = strings.TrimSpace(req.PaymentMethodID)
	}
	return pm
}

func (h AccountHandler) AttachCard(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	// Idempotent: a stored subscription id means one already exists at
	// Stripe — subscribing again would bill the customer twice while we
	// overwrite the old id and lose track of it. The cancellation webhook
	// clears stripe_subscription_id, which is what re-opens this path.
	if acct.StripeSub != "" {
		already := acct.BillingStatus == "active" || acct.BillingStatus == "dev"
		JSON(w, http.StatusOK, map[string]any{"ok": true, "already_active": already})
		return
	}
	var raw json.RawMessage
	_ = json.NewDecoder(r.Body).Decode(&raw)
	pm := paymentMethodFromJSON(raw)
	cust, err := billing.EnsureCustomer(acct.Email, acct.StripeCustomer)
	if err != nil {
		writeBillingErr(w, err, "Could not start the monthly bill. Check the card and try again.")
		return
	}
	if cust != acct.StripeCustomer {
		_, _ = h.DB.Exec(`UPDATE accounts SET stripe_customer_id = ? WHERE id = ?`, cust, acct.ID)
		acct.StripeCustomer = cust
	}
	sub, item, err := billing.Subscribe(cust, pm)
	if err != nil {
		writeBillingErr(w, err, "Could not start the monthly bill. Check the card and try again.")
		return
	}
	status := "active"
	out := map[string]any{"ok": true}
	if billing.DevBypass() {
		status = "dev"
		out["dev"] = true
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = ?, stripe_subscription_id = ?, stripe_subscription_item_id = ?, backup_purge_after = NULL, purge_mail_day = NULL WHERE id = ?`,
		status, sub, item, acct.ID)
	JSON(w, http.StatusOK, out)
}

func (h AccountHandler) CancelBilling(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	if acct.StripeSub != "" {
		if err := billing.CancelSubscription(acct.StripeSub); err != nil {
			writeBillingErr(w, err, "Could not turn off payment. Try again in a few minutes.")
			return
		}
	}
	deadline := scheduleBackupPurge(h.DB, acct.ID)
	_, _ = h.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = 'canceled', stripe_subscription_id = '', stripe_subscription_item_id = '' WHERE id = ?`, acct.ID)
	markAndSendPurgeWarning(h.Deps, acct.ID, acct.Email, 0, deadline)
	JSON(w, http.StatusOK, map[string]any{
		"ok":                 true,
		"backup_purge_after": deadline,
		"message":            "Payment is off. We keep your cloud copies for 30 days. Download anything you need before then.",
	})
}

func writeBillingErr(w http.ResponseWriter, err error, fallback string) {
	if errors.Is(err, billing.ErrNotConfigured) {
		JSONError(w, http.StatusServiceUnavailable, "Card billing is not set up on this Luna Connect site. Contact support to resolve this issue.")
		return
	}
	if errors.Is(err, billing.ErrPaymentMethodRequired) {
		JSONError(w, http.StatusBadRequest, "Add a card on this page first, then try again.")
		return
	}
	if errors.Is(err, billing.ErrSubscriptionInactive) {
		JSONError(w, http.StatusPaymentRequired, "The card was saved but the monthly bill is not active yet. Check the card and try again.")
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
	_ = h.DB.QueryRow(`SELECT COALESCE(SUM(size),0) FROM backup_objects WHERE account_id = ?`, acct.ID).Scan(&liveBytes)
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
	rows, err := h.DB.Query(`SELECT id, COALESCE(name,''), COALESCE(subdomain,''), COALESCE(code_hint,''), COALESCE(last_seen_at,0), kind FROM devices WHERE account_id = ?`, acct.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not load this Luna.")
		return
	}
	defer rows.Close()
	now := time.Now().Unix()
	out := []map[string]any{}
	for rows.Next() {
		var id, name, sub, hint, kind string
		var lastSeen int64
		_ = rows.Scan(&id, &name, &sub, &hint, &lastSeen, &kind)
		item := map[string]any{
			"id":           id,
			"name":         name,
			"kind":         kind,
			"code_hint":    hint,
			"last_seen_at": lastSeen,
			"online":       lastSeen > 0 && now-lastSeen <= OnlineWithinSec,
			"subdomain":    sub,
		}
		if sub != "" {
			item["hostname"] = sub + "." + config.C.Server.PublicZone
		}
		out = append(out, item)
	}
	JSON(w, http.StatusOK, map[string]any{"devices": out})
}

// RevealDeviceCode returns the plaintext device code once for Show Code (re-mint not possible;
// we cannot reverse the hash). Support path stores only hash — reveal is not available for
// hashed codes. Instead we return the hint and instruct to use the quick-start card.
// For DIY codes shown at mint time only. Official: card / support remint.
func (h AccountHandler) RevealDeviceCode(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	id := chi.URLParam(r, "deviceID")
	var hint, sealed string
	var account sql.NullString
	err := h.DB.QueryRow(`SELECT COALESCE(code_hint,''), COALESCE(code_sealed,''), account_id FROM devices WHERE id = ?`, id).Scan(&hint, &sealed, &account)
	if err != nil || !account.Valid || account.String != acct.ID {
		JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		return
	}
	if sealed == "" {
		JSON(w, http.StatusOK, map[string]any{
			"code_hint": hint,
			"message":   "The full device token is on your quick-start card. We only keep a short hint here for older records.",
		})
		return
	}
	code, err := security.OpenString(sealed)
	if err != nil || code == "" {
		JSONError(w, http.StatusInternalServerError, "Could not read the device token. Contact support.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"code": code, "code_hint": hint})
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

func (h AccountHandler) OptionalAccountAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("luna_connect_session")
		if err != nil {
			next.ServeHTTP(w, r)
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
			next.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithAccount(r.Context(), Account{
			ID: id, Email: email, HasCard: has == 1, BillingStatus: status,
			StripeCustomer: cust, StripeSub: sub, BackupPurgeAfter: purgeAfter, EmailVerified: emailVerified == 1,
			OnboardingPath: obPath, OnboardingStep: obStep,
		})))
	})
}
