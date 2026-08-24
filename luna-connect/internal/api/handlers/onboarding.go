package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/setuphub"
)

type OnboardingHandler struct {
	Deps
}

type issuedToken struct {
	ID        string
	Hash      string
	Kind      string
	Status    string
	AccountID sql.NullString
	Expires   sql.NullInt64
}

func lookupIssued(db *sql.DB, norm string) (issuedToken, bool) {
	return lookupIssuedByHash(db, security.HashToken(norm))
}

func lookupIssuedByHash(db *sql.DB, hash string) (issuedToken, bool) {
	var t issuedToken
	err := db.QueryRow(`SELECT id, token_hash, kind, status, account_id, expires_at FROM issued_tokens WHERE token_hash = ?`, hash).
		Scan(&t.ID, &t.Hash, &t.Kind, &t.Status, &t.AccountID, &t.Expires)
	if err != nil {
		return t, false
	}
	if t.Expires.Valid && t.Expires.Int64 > 0 && time.Now().Unix() > t.Expires.Int64 {
		_, _ = db.Exec(`UPDATE issued_tokens SET status = 'expired' WHERE id = ? AND status = 'issued'`, t.ID)
		t.Status = "expired"
	}
	return t, true
}

func tokenAccountID(t issuedToken) string {
	if t.AccountID.Valid {
		return t.AccountID.String
	}
	return ""
}

func sessionAccountID(s *sessionRow) string {
	if s != nil && s.accountID.Valid {
		return s.accountID.String
	}
	return ""
}

func liveSetupStatus(status string) bool {
	return status == "waiting_device" || status == "attached"
}

func (h OnboardingHandler) Bind(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	norm := security.NormalizeToken(req.Code)
	if norm == "" {
		JSONError(w, http.StatusBadRequest, "Type the device code from the booklet, or the short code from this website.")
		return
	}
	if !allowGuess(h.DB, clientKeyIP(r), 8, 15*60) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then type the code again carefully.")
		return
	}
	if acct, ok := AccountFrom(r.Context()); ok {
		if !allowGuess(h.DB, clientKeyAccount(acct.ID), 20, 3600) {
			JSONError(w, http.StatusTooManyRequests, "Too many tries on this account. Wait a bit, then try again.")
			return
		}
	}
	tok, ok := lookupIssued(h.DB, norm)
	if !ok || tok.Status != "issued" {
		JSONError(w, http.StatusBadRequest, "That code is wrong, already used, or expired. Check the booklet or the Luna Connect site.")
		return
	}
	acct, hasAcct := AccountFrom(r.Context())
	if tok.Kind == "oss" {
		if !hasAcct {
			JSONError(w, http.StatusUnauthorized, "Sign in to the Luna Connect account that created this short code, then type it again.")
			return
		}
		if tokenAccountID(tok) != acct.ID {
			JSONError(w, http.StatusForbidden, "That short code belongs to a different account. Sign in to the account that created it, then try again.")
			return
		}
	}
	id := security.NewID("sess")
	now := time.Now()
	exp := now.Add(setuphub.SessionTTL).Unix()
	acctID := ""
	if hasAcct {
		acctID = acct.ID
	}
	_, _ = h.DB.Exec(`UPDATE setup_sessions SET status = 'replaced' WHERE token_hash = ? AND status IN ('waiting_device','attached')`, tok.Hash)
	_, err := h.DB.Exec(`INSERT INTO setup_sessions (id, token_hash, account_id, status, created_at, expires_at) VALUES (?, ?, ?, 'waiting_device', ?, ?)`,
		id, tok.Hash, nullIfEmpty(acctID), now.Unix(), exp)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not start setup. Try again.")
		return
	}
	status := "waiting_device"
	plugCopy := "Plug the included cable from Luna into a LAN socket on your internet box — the same kind of socket your home internet uses. Keep this page open. We will continue when Luna comes online."
	if h.Hub != nil && h.Hub.HasLive(tok.Hash) {
		status = "attached"
		_, _ = h.DB.Exec(`UPDATE setup_sessions SET status = 'attached' WHERE id = ?`, id)
		_ = h.Hub.Push(tok.Hash, setuphub.Message{Type: "attached", SessionID: id, Kind: tok.Kind})
		plugCopy = ""
	}
	setSetupSessionCookie(w, id)
	JSON(w, http.StatusOK, map[string]any{
		"session_id": id,
		"status":     status,
		"kind":       tok.Kind,
		"message":    plugCopy,
		"timeout_s":  int(setuphub.SessionTTL.Seconds()),
	})
}

func (h OnboardingHandler) Session(w http.ResponseWriter, r *http.Request) {
	sess := h.loadSession(r)
	if sess == nil {
		JSONError(w, http.StatusNotFound, "This setup page expired. Type the device code again.")
		return
	}
	live := h.Hub != nil && h.Hub.HasLive(sess.tokenHash)
	status := sess.status
	if live && status == "waiting_device" {
		status = "attached"
		_, _ = h.DB.Exec(`UPDATE setup_sessions SET status = 'attached' WHERE id = ?`, sess.id)
	}
	msg := ""
	if status == "waiting_device" {
		if time.Now().Unix() > sess.expires {
			JSONError(w, http.StatusGone, "We never saw Luna come online. Check that the included cable is plugged from Luna into a LAN socket on your internet box, then type the code again.")
			return
		}
		msg = "Plug the included cable from Luna into a LAN socket on your internet box. Keep this page open."
	}
	JSON(w, http.StatusOK, map[string]any{
		"session_id": sess.id,
		"status":     status,
		"kind":       sess.kind,
		"live":       live,
		"message":    msg,
	})
}

func (h OnboardingHandler) AttachAccount(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Create a Luna Connect account, then continue.")
		return
	}
	sess := h.loadWritableSession(r)
	if sess == nil {
		JSONError(w, http.StatusNotFound, "Type the device code first.")
		return
	}
	if existing := sessionAccountID(sess); existing != "" && existing != acct.ID {
		JSONError(w, http.StatusForbidden, "This setup page is already tied to another account. Sign in to that account to continue.")
		return
	}
	newID := security.NewID("sess")
	res, err := h.DB.Exec(`UPDATE setup_sessions SET id = ?, account_id = ? WHERE id = ? AND (account_id IS NULL OR account_id = ?)`,
		newID, acct.ID, sess.id, acct.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not link this account to setup. Try again.")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		JSONError(w, http.StatusForbidden, "This setup page is already tied to another account. Sign in to that account to continue.")
		return
	}
	setSetupSessionCookie(w, newID)
	JSON(w, http.StatusOK, map[string]any{"ok": true, "session_id": newID})
}

func (h OnboardingHandler) Name(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Create a Luna Connect account, then pick a name.")
		return
	}
	sess := h.loadWritableSession(r)
	if sess == nil {
		JSONError(w, http.StatusNotFound, "Type the device code first.")
		return
	}
	if time.Now().Unix() > sess.expires {
		JSONError(w, http.StatusGone, "This setup page expired. Plug the cable in, then type the device code again.")
		return
	}
	if existing := sessionAccountID(sess); existing != "" && existing != acct.ID {
		JSONError(w, http.StatusForbidden, "This setup page is already tied to another account. Sign in to that account to pick a name.")
		return
	}
	tok, tokOK := lookupIssuedByHash(h.DB, sess.tokenHash)
	if !tokOK || tok.Status != "issued" {
		JSONError(w, http.StatusConflict, "This setup code was already used or expired. Type a new code from the booklet or the Luna Connect site.")
		return
	}
	if tok.Kind == "oss" && tokenAccountID(tok) != acct.ID {
		JSONError(w, http.StatusForbidden, "That short code belongs to a different account. Sign in to the account that created it, then try again.")
		return
	}
	if h.Hub == nil || !h.Hub.HasLive(sess.tokenHash) {
		JSONError(w, http.StatusConflict, "Luna is not online yet. Plug the included cable from Luna into a LAN socket on your internet box, then wait until this page says it is connected.")
		return
	}
	var n int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE account_id = ?`, acct.ID).Scan(&n)
	if n >= setuphub.MaxDevicesPerAccount {
		JSONError(w, http.StatusConflict, "This account already has as many Lunas as it can hold. Remove one first, or use another account.")
		return
	}
	var req struct {
		Subdomain string `json:"subdomain"`
		LocalPort int    `json:"local_port"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	sub := domainname.Normalize(req.Subdomain)
	if msg := domainname.Validate(sub); msg != "" {
		JSONError(w, http.StatusBadRequest, msg)
		return
	}
	var exists int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE subdomain = ?`, sub).Scan(&exists)
	if exists > 0 {
		JSONError(w, http.StatusConflict, "That name is already in use. Pick another.")
		return
	}
	sock := h.Hub.Live(sess.tokenHash)
	port := req.LocalPort
	if port <= 0 && sock != nil {
		port = sock.LocalPort
	}
	if port <= 0 {
		port = 8090
	}

	hostname := domainname.Hostname(sub, config.C.Server.PublicZone)
	creds, err := h.Tunnel.CreateTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, "luna-"+sub)
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Could not set up the protected connection. Try again in a few minutes.")
		return
	}
	serviceURL := "http://127.0.0.1:" + itoa(port)
	if err := h.Tunnel.ConfigureIngress(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, creds.TunnelID, hostname, serviceURL); err != nil {
		h.rollbackCloud(creds.TunnelID, hostname)
		JSONError(w, http.StatusBadGateway, "Could not finish the protected connection. Try again.")
		return
	}
	target := creds.TunnelID + ".cfargotunnel.com"
	if err := h.DNS.UpsertCNAME(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, hostname, target); err != nil {
		h.rollbackCloud(creds.TunnelID, hostname)
		JSONError(w, http.StatusBadGateway, "Could not publish the address. Try again.")
		return
	}

	deviceToken := security.RandomHex(24)
	setupSecret := security.RandomHex(16)
	id := security.NewID("dev")
	pushed := h.Hub.ClaimAndDrop(sess.tokenHash, setuphub.Message{
		Type:        "claimed",
		DeviceToken: deviceToken,
		Hostname:    hostname,
		TunnelToken: creds.Token,
		SetupSecret: setupSecret,
		Subdomain:   sub,
	})
	if !pushed {
		h.rollbackCloud(creds.TunnelID, hostname)
		JSONError(w, http.StatusConflict, "Luna dropped off the line before we could finish. Plug the cable in and try again.")
		return
	}
	_, err = h.DB.Exec(`INSERT INTO devices (id, account_id, token_hash, name, subdomain, tunnel_id, tunnel_token, local_port, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, acct.ID, security.HashToken(deviceToken), "Luna", sub, creds.TunnelID, creds.Token, port, time.Now().Unix())
	if err != nil {
		// Luna may already have tunnel creds from ClaimAndDrop. Drop Cloudflare
		// resources and leave the booklet token issued so a later hello + Name
		// can mint a new tunnel. Do not mark the token claimed.
		h.rollbackCloud(creds.TunnelID, hostname)
		JSONError(w, http.StatusConflict, "That name is already in use. Pick another.")
		return
	}
	_, _ = h.DB.Exec(`UPDATE issued_tokens SET status = 'claimed', claimed_device_id = ? WHERE token_hash = ?`, id, sess.tokenHash)
	_, _ = h.DB.Exec(`UPDATE setup_sessions SET status = 'claimed', account_id = ? WHERE id = ?`, acct.ID, sess.id)
	JSON(w, http.StatusCreated, map[string]any{
		"device_id": id,
		"hostname":  hostname,
		"subdomain": sub,
	})
}

func (h OnboardingHandler) Backups(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var req struct {
		Enable bool `json:"enable"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if !req.Enable {
		JSON(w, http.StatusOK, map[string]any{"ok": true, "enabled": false})
		return
	}
	sub, err := billing.Subscribe(acct.StripeCustomer)
	if err != nil {
		if errors.Is(err, billing.ErrNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Card billing is not set up on this Luna Connect site. Ask the person who looks after it, then try again.")
			return
		}
		JSONError(w, http.StatusBadGateway, "Could not start spare copies. Check the card and try again.")
		return
	}
	status := "active"
	price := "Spare copies cost $7 per terabyte each month."
	if billing.DevBypass() {
		status = "dev"
		price = "Spare copies cost $7 per terabyte each month. Luna will turn cloud copies on when it is next quiet."
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = ?, stripe_subscription_id = ? WHERE id = ?`, status, sub, acct.ID)
	JSON(w, http.StatusOK, map[string]any{
		"ok": true, "enabled": true,
		"price_copy": price,
	})
}

func (h OnboardingHandler) VerifyHuman(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Create a Luna Connect account first.")
		return
	}
	okMsg := "A dollar to confirm this is a real person. It counts toward cloud copies if you turn those on."
	var existing string
	err := h.DB.QueryRow(`SELECT payment_intent_id FROM oss_payments WHERE account_id = ? AND status = 'succeeded'`, acct.ID).Scan(&existing)
	if err == nil && existing != "" {
		JSON(w, http.StatusOK, map[string]any{"ok": true, "message": okMsg})
		return
	}
	// JSON body: { "payment_method_id": "<id>" } (website) or { "payment_method": "<id>" }.
	// Stripe PaymentMethod id after the person saved a card. Required when card charges are on.
	var req struct {
		PaymentMethod   string `json:"payment_method"`
		PaymentMethodID string `json:"payment_method_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	pm := strings.TrimSpace(req.PaymentMethod)
	if pm == "" {
		pm = strings.TrimSpace(req.PaymentMethodID)
	}
	pi, err := billing.ChargeOneDollar(acct.StripeCustomer, pm)
	if err != nil {
		if errors.Is(err, billing.ErrPaymentMethodRequired) {
			JSONError(w, http.StatusBadRequest, "Add a card on this page first, then try again.")
			return
		}
		if errors.Is(err, billing.ErrNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Card checks are not available right now. Try again later, or ask the person who looks after this Luna Connect site.")
			return
		}
		JSONError(w, http.StatusBadGateway, "We could not take the dollar to confirm this is a real person. Check the card and try again.")
		return
	}
	_, _ = h.DB.Exec(`INSERT INTO oss_payments (account_id, payment_intent_id, status, created_at) VALUES (?, ?, 'succeeded', ?)
ON CONFLICT(account_id) DO UPDATE SET payment_intent_id=excluded.payment_intent_id, status='succeeded'`,
		acct.ID, pi, time.Now().Unix())
	JSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": okMsg,
	})
}

func (h OnboardingHandler) MintOSS(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Create a Luna Connect account first.")
		return
	}
	var status string
	err := h.DB.QueryRow(`SELECT status FROM oss_payments WHERE account_id = ?`, acct.ID).Scan(&status)
	if err != nil || status != "succeeded" {
		JSONError(w, http.StatusPaymentRequired, "Pay one dollar first so we know this is a real person. It counts toward cloud copies if you turn those on.")
		return
	}
	code := security.OSSHexToken()
	id := security.NewID("tok")
	exp := time.Now().Add(15 * time.Minute).Unix()
	_, err = h.DB.Exec(`INSERT INTO issued_tokens (id, token_hash, kind, status, account_id, expires_at, created_at)
VALUES (?, ?, 'oss', 'issued', ?, ?, ?)`, id, security.HashToken(code), acct.ID, exp, time.Now().Unix())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not make a setup code. Try again.")
		return
	}
	JSON(w, http.StatusCreated, map[string]any{
		"code":       code,
		"expires_in": 15 * 60,
		"message":    "On Luna, open the address on the screen and enter this code.",
	})
}

func (h OnboardingHandler) rollbackCloud(tunnelID, hostname string) {
	if h.DNS != nil && hostname != "" {
		_ = h.DNS.DeleteRecord(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, hostname)
	}
	if h.Tunnel != nil && tunnelID != "" {
		_ = h.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tunnelID)
	}
}

func (h OnboardingHandler) AdminMint(w http.ResponseWriter, r *http.Request) {
	if config.C.Server.AdminToken == "" || r.Header.Get("Authorization") != "Bearer "+config.C.Server.AdminToken {
		JSONError(w, http.StatusUnauthorized, "Admin sign-in required.")
		return
	}
	// Replacement official tokens: there is no public remint. Support mints here
	// after the owner contacts support with their order id (lost booklet / wiped disk).
	display := security.OfficialBookletToken()
	norm := security.NormalizeToken(display)
	id := security.NewID("tok")
	_, err := h.DB.Exec(`INSERT INTO issued_tokens (id, token_hash, kind, status, created_at) VALUES (?, ?, 'official', 'issued', ?)`,
		id, security.HashToken(norm), time.Now().Unix())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not mint a booklet code.")
		return
	}
	JSON(w, http.StatusCreated, map[string]any{
		"id":     id,
		"token":  display,
		"kind":   "official",
		"status": "issued",
	})
}

type sessionRow struct {
	id        string
	tokenHash string
	accountID sql.NullString
	status    string
	expires   int64
	kind      string
}

func (h OnboardingHandler) loadSession(r *http.Request) *sessionRow {
	id := setupSessionID(r)
	if id == "" {
		return nil
	}
	var s sessionRow
	err := h.DB.QueryRow(`SELECT s.id, s.token_hash, s.account_id, s.status, s.expires_at, t.kind
FROM setup_sessions s JOIN issued_tokens t ON t.token_hash = s.token_hash
WHERE s.id = ?`, id).Scan(&s.id, &s.tokenHash, &s.accountID, &s.status, &s.expires, &s.kind)
	if err != nil {
		return nil
	}
	if s.status == "replaced" {
		return nil
	}
	return &s
}

func (h OnboardingHandler) loadWritableSession(r *http.Request) *sessionRow {
	sess := h.loadSession(r)
	if sess == nil || !liveSetupStatus(sess.status) {
		return nil
	}
	return sess
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
