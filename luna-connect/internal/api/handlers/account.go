package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type AccountHandler struct {
	Deps
}

const authAttemptMax = 10
const authAttemptWindow = 15 * 60

// SessionTTL is how long a signed-in Luna Connect browser session lasts.
// Matches lunad's 7-day session cap so a stolen cookie does not live a month.
const SessionTTL = 7 * 24 * time.Hour

func (h AccountHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !allowAuthAttempt(h.DB, ClientIP(r), email, authAttemptMax, authAttemptWindow) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
		return
	}
	if !auth.ValidEmail(email) {
		JSONError(w, http.StatusBadRequest, "Enter a valid email address.")
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
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
	_, err = h.DB.Exec(`INSERT INTO accounts (id, email, password_hash, stripe_customer_id, has_card, billing_status, created_at)
VALUES (?, ?, ?, ?, 0, 'none', ?)`, id, email, string(hash), cust, time.Now().Unix())
	if err != nil {
		JSONError(w, http.StatusConflict, "That email already has an account. Sign in instead.")
		return
	}
	h.setSession(w, id)
	JSON(w, http.StatusCreated, map[string]any{"id": id, "email": email, "has_card": false, "stripe_publishable_key": stripePublishableKey()})
}

func (h AccountHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !allowAuthAttempt(h.DB, ClientIP(r), email, authAttemptMax, authAttemptWindow) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
		return
	}
	var id, hash string
	err := h.DB.QueryRow(`SELECT id, password_hash FROM accounts WHERE email = ?`, email).Scan(&id, &hash)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		JSONError(w, http.StatusUnauthorized, "That email or password did not match.")
		return
	}
	h.setSession(w, id)
	JSON(w, http.StatusOK, map[string]any{"ok": true})
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
	JSON(w, http.StatusOK, map[string]any{
		"id":                     acct.ID,
		"email":                  acct.Email,
		"has_card":               acct.HasCard && billing.BackupsUnlocked(acct.HasCard, acct.BillingStatus),
		"billing_status":         acct.BillingStatus,
		"stored_bytes":           liveBytes,
		"avg_stored_bytes":       avgBytes,
		"egress_bytes":           egressBytes,
		"estimated_month":        billing.EstimateMonthUSD(avgBytes, egressBytes),
		"price_copy":             "Cloud backup costs $8 per terabyte each month, based on your average storage over the month. Downloads are free up to three times that average; extra download traffic is $0.01 per GB.",
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
	_, _ = h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = ?, stripe_subscription_id = ?, stripe_subscription_item_id = ? WHERE id = ?`,
		status, sub, item, acct.ID)
	JSON(w, http.StatusOK, out)
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
		"stored_bytes":          liveBytes,
		"avg_stored_bytes":      avgBytes,
		"egress_bytes":          egressBytes,
		"egress_overage_gb":     billing.EgressOverageGB(avgBytes, egressBytes),
		"estimated_month_usd":   billing.EstimateMonthUSD(avgBytes, egressBytes),
	})
}

func (h AccountHandler) Pair(w http.ResponseWriter, r *http.Request) {
	JSONError(w, http.StatusGone, "Pairing codes from Luna are gone. Open Setup on this site, type the device code (purchased from LibreLoom or from this website: ****-****-****-****-****), and pick a name.")
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
	rows, err := h.DB.Query(`SELECT id, name, subdomain FROM devices WHERE account_id = ?`, acct.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list Lunas.")
		return
	}
	defer rows.Close()
	out := []map[string]string{}
	for rows.Next() {
		var id, name, sub string
		_ = rows.Scan(&id, &name, &sub)
		out = append(out, map[string]string{
			"id": id, "name": name, "hostname": sub + "." + config.C.Server.PublicZone, "subdomain": sub,
		})
	}
	JSON(w, http.StatusOK, map[string]any{"devices": out})
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
		var id, email, status, cust, sub string
		var has int
		err = h.DB.QueryRow(`
SELECT a.id, a.email, a.has_card, a.billing_status, COALESCE(a.stripe_customer_id,''), COALESCE(a.stripe_subscription_id,'')
FROM sessions s JOIN accounts a ON a.id = s.account_id
WHERE s.token_hash = ? AND s.expires_at > ?`, security.HashToken(c.Value), time.Now().Unix()).
			Scan(&id, &email, &has, &status, &cust, &sub)
		if err != nil {
			JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
			return
		}
		next.ServeHTTP(w, r.WithContext(WithAccount(r.Context(), Account{
			ID: id, Email: email, HasCard: has == 1, BillingStatus: status, StripeCustomer: cust, StripeSub: sub,
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
		var id, email, status, cust, sub string
		var has int
		err = h.DB.QueryRow(`
SELECT a.id, a.email, a.has_card, a.billing_status, COALESCE(a.stripe_customer_id,''), COALESCE(a.stripe_subscription_id,'')
FROM sessions s JOIN accounts a ON a.id = s.account_id
WHERE s.token_hash = ? AND s.expires_at > ?`, security.HashToken(c.Value), time.Now().Unix()).
			Scan(&id, &email, &has, &status, &cust, &sub)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithAccount(r.Context(), Account{
			ID: id, Email: email, HasCard: has == 1, BillingStatus: status, StripeCustomer: cust, StripeSub: sub,
		})))
	})
}

func (h DeviceHandler) DeviceAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := security.BearerToken(r.Header.Get("Authorization"))
		if tok == "" {
			JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
			return
		}
		var d Device
		var account sql.NullString
		err := h.DB.QueryRow(`SELECT id, account_id, subdomain, COALESCE(tunnel_id,''), COALESCE(name,'') FROM devices WHERE token_hash = ?`,
			security.HashToken(tok)).Scan(&d.ID, &account, &d.Subdomain, &d.TunnelID, &d.Name)
		if err != nil {
			JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
			return
		}
		d.AccountID = account
		next.ServeHTTP(w, r.WithContext(WithDevice(r.Context(), d)))
	})
}
