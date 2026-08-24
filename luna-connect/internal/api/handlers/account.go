package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type AccountHandler struct {
	Deps
}

func (h AccountHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !strings.Contains(email, "@") || len(req.Password) < 8 {
		JSONError(w, http.StatusBadRequest, "Enter an email and a password of at least 8 characters.")
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
	JSON(w, http.StatusCreated, map[string]any{"id": id, "email": email, "has_card": false})
}

func (h AccountHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	email := strings.ToLower(strings.TrimSpace(req.Email))
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
	var bytes int64
	_ = h.DB.QueryRow(`SELECT COALESCE(SUM(size),0) FROM backup_objects WHERE account_id = ?`, acct.ID).Scan(&bytes)
	JSON(w, http.StatusOK, map[string]any{
		"id":              acct.ID,
		"email":           acct.Email,
		"has_card":        acct.HasCard,
		"billing_status":  acct.BillingStatus,
		"stored_bytes":    bytes,
		"estimated_month": billing.EstimateUSD(bytes),
		"price_copy":      "Spare copies cost $7 per terabyte each month, based on how much is stored right now.",
	})
}

func (h AccountHandler) AttachCard(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	if !config.C.Stripe.Ready() {
		sub, _ := billing.Subscribe(acct.StripeCustomer)
		_, _ = h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'dev', stripe_subscription_id = ? WHERE id = ?`, sub, acct.ID)
		JSON(w, http.StatusOK, map[string]any{"ok": true, "dev": true})
		return
	}
	sub, err := billing.Subscribe(acct.StripeCustomer)
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Could not start the monthly bill. Check the card and try again.")
		return
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active', stripe_subscription_id = ? WHERE id = ?`, sub, acct.ID)
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h AccountHandler) Usage(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var bytes int64
	_ = h.DB.QueryRow(`SELECT COALESCE(SUM(size),0) FROM backup_objects WHERE account_id = ?`, acct.ID).Scan(&bytes)
	JSON(w, http.StatusOK, map[string]any{
		"stored_bytes":        bytes,
		"estimated_month_usd": billing.EstimateUSD(bytes),
	})
}

func (h AccountHandler) Pair(w http.ResponseWriter, r *http.Request) {
	JSONError(w, http.StatusGone, "Pairing codes from Luna are gone. Open Setup on this site, type the booklet or website code, and pick a name.")
}

func (h AccountHandler) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("luna_connect_session"); err == nil {
		_, _ = h.DB.Exec(`DELETE FROM sessions WHERE token_hash = ?`, security.HashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{
		Name: "luna_connect_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode,
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
		security.HashToken(tok), accountID, time.Now().Add(30*24*time.Hour).Unix())
	http.SetCookie(w, &http.Cookie{
		Name:     "luna_connect_session",
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   30 * 24 * 3600,
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
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
			return
		}
		tok := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
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
