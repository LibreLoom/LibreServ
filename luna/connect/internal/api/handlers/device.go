package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type DeviceHandler struct {
	Deps
}

func (h DeviceHandler) Available(w http.ResponseWriter, r *http.Request) {
	name := domainname.Normalize(r.URL.Query().Get("name"))
	if msg := domainname.Validate(name); msg != "" {
		JSON(w, http.StatusOK, map[string]any{"available": false, "reason": msg})
		return
	}
	var n int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE subdomain = ?`, name).Scan(&n)
	JSON(w, http.StatusOK, map[string]any{"available": n == 0, "hostname": domainname.Hostname(name, config.C.Server.PublicZone)})
}

// Unbind invalidates the rolling credential and clears the account link. The
// device row and the device token's hash remain. A revoked Luna
// also requires the account password so a stolen session cannot finish the
// emergency disconnect that revocation deliberately left linked to its owner.
func (h DeviceHandler) Unbind(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	id := chi.URLParam(r, "deviceID")
	var d Device
	var account sql.NullString
	var sub, tunnelID, state, authHash sql.NullString
	err := h.DB.QueryRow(`SELECT id, account_id, COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(name,''),
       COALESCE(state,'unbound'), COALESCE(auth_token_hash,'') FROM devices WHERE id = ?`, id).
		Scan(&d.ID, &account, &sub, &tunnelID, &d.Name, &state, &authHash)
	if err != nil || !account.Valid || account.String != acct.ID {
		JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		return
	}
	d.AccountID = account
	d.Subdomain = sub.String
	d.TunnelID = tunnelID.String
	d.State = state.String
	d.AuthTokenHash = authHash.String
	var req struct {
		Password      string `json:"password"`
		CancelBilling bool   `json:"cancel_billing"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	if d.State == "revoked" {
		if req.Password == "" {
			JSONError(w, http.StatusBadRequest, "Enter your password to disconnect this Luna.")
			return
		}
		if status, message := verifyDeviceDisconnectPassword(h.DB, r, acct, req.Password); status != 0 {
			JSONError(w, status, message)
			return
		}
	}
	// Turning payment off first means a failure leaves the Luna linked and
	// nothing deleted, so the person can simply try again.
	billingMessage := ""
	if req.CancelBilling {
		msg, ok := AccountHandler{Deps: h.Deps}.cancelBillingFor(w, acct)
		if !ok {
			return
		}
		billingMessage = msg
	}
	if err := unbindDevice(h.Deps, d, acct.ID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "Could not disconnect this Luna. Try again.")
		return
	}
	obPath := acct.OnboardingPath
	if obPath == "" {
		obPath = "official"
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_step = ? WHERE id = ?`, defaultCodeStep(obPath), acct.ID)
	JSON(w, http.StatusOK, map[string]any{"ok": true, "status": "unbound", "billing_message": billingMessage})
}

// verifyDeviceDisconnectPassword shares sign-in's persisted limits. A correct
// password is accepted even when the per-account bucket is full, then clears it;
// wrong passwords receive the same generic throttle as sign-in.
func verifyDeviceDisconnectPassword(db *database.DB, r *http.Request, acct Account, password string) (int, string) {
	email := strings.ToLower(strings.TrimSpace(acct.Email))
	ip := ClientIP(r)
	if authBlocked(db, ip, email, authAttemptMax, authAttemptWindow) {
		return http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again."
	}
	accountKey := signInAccountKey("customer", email)
	accountCapped := guessBlocked(db, accountKey, signInAccountAttemptMax, signInAccountAttemptWindow)
	var hash string
	err := db.QueryRow(`SELECT password_hash FROM accounts WHERE id = ?`, acct.ID).Scan(&hash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return http.StatusInternalServerError, "Could not check your password. Try again."
	}
	if errors.Is(err, sql.ErrNoRows) {
		_ = auth.VerifyDummyPassword(password)
	}
	if err != nil || auth.VerifyPassword(hash, password) != nil {
		if accountCapped {
			return http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again."
		}
		_ = allowAuthAttempt(db, ip, email, authAttemptMax, authAttemptWindow)
		_ = allowGuess(db, accountKey, signInAccountAttemptMax, signInAccountAttemptWindow)
		return http.StatusForbidden, "That password is wrong. This Luna was not disconnected."
	}
	clearSignInAccountAttempts(db, accountKey)
	return 0, ""
}

// SetDomain provisions tunnel+DNS for a bound device (account-side).
func (h DeviceHandler) SetDomain(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	id := chi.URLParam(r, "deviceID")
	var req struct {
		Subdomain string `json:"subdomain"`
		LocalPort int    `json:"local_port"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	var account sql.NullString
	var current, state, authHash string
	err := h.DB.QueryRow(`SELECT account_id, COALESCE(subdomain, ''), COALESCE(state,'unbound'), COALESCE(auth_token_hash,'') FROM devices WHERE id = ?`, id).Scan(&account, &current, &state, &authHash)
	if err != nil || !account.Valid || account.String != acct.ID || state != "bound" {
		JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		return
	}
	expected := Device{ID: id, State: state, AccountID: account, AuthTokenHash: authHash, Subdomain: current}
	// Moving a Luna that already has an address drives the shared Cloudflare
	// token, so one account cannot loop it. Choosing the first address is setup.
	// A name that fails the local check never reaches Cloudflare, so it is not
	// counted against the allowance.
	normalized := domainname.Normalize(req.Subdomain)
	if current != "" && current != normalized && domainname.Validate(normalized) == "" && !allowDomainChange(h.DB, acct.ID) {
		JSONError(w, http.StatusTooManyRequests, domainChangeMsg)
		return
	}
	out, status, msg := applyDeviceDomain(h.Deps, id, req.Subdomain, req.LocalPort, expected)
	if msg != "" {
		JSONError(w, status, msg)
		return
	}
	if status == http.StatusCreated {
		_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_step = CASE WHEN onboarding_step IS NULL OR onboarding_step IN ('verify','bind','domain') THEN 'backup' ELSE onboarding_step END WHERE id = ?`, acct.ID)
	}
	JSON(w, status, out)
}

// Status is called by Luna with its current rolling credential. DeviceAuth
// rejects unbound, pairing, revoked, previous, and legacy tokens before here.
func (h DeviceHandler) Status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	expected, ok := DeviceFrom(r.Context())
	if !ok {
		deviceCredentialError(w)
		return
	}
	dev, err := revalidateDeviceAuth(h.DB, expected)
	if err != nil {
		writeDeviceAuthError(w, err)
		return
	}
	if !dev.AccountID.Valid || dev.AccountID.String == "" {
		JSONError(w, http.StatusForbidden, "This Luna is not linked to a Luna Connect account yet. Finish setup at connect.luna.libreloom.org.")
		return
	}
	now := time.Now().Unix()
	touchLastSeenForDevice(h.DB, dev, now)

	if portHeader := r.Header.Get("X-Luna-Local-Port"); portHeader != "" {
		if port, err := strconv.Atoi(portHeader); err == nil {
			if err := syncDeviceLocalPortFenced(h.Deps, dev, port); err != nil {
				if errors.Is(err, errInvalidDeviceCredential) || errors.Is(err, errDeviceUnbound) || errors.Is(err, errDeviceRevoked) {
					writeDeviceAuthError(w, err)
					return
				}
				slog.Warn("device status: could not sync local port", "device_id", dev.ID, "err", err)
			}
		}
	}

	unlocked := false
	var hasCard int
	var status string
	_ = h.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE id = ?`, dev.AccountID.String).Scan(&hasCard, &status)
	unlocked = billing.BackupsUnlocked(hasCard == 1, status)

	var sealed, sub sql.NullString
	var tunnelID string
	err = h.DB.QueryRow(`SELECT subdomain, tunnel_token, COALESCE(tunnel_id, '') FROM devices
 WHERE id = ? AND account_id = ? AND state = 'bound' AND auth_token_hash = ?`,
		dev.ID, dev.AccountID.String, dev.AuthTokenHash).Scan(&sub, &sealed, &tunnelID)
	if err != nil {
		if current, authErr := revalidateDeviceAuth(h.DB, expected); authErr != nil {
			writeDeviceAuthError(w, authErr)
			return
		} else if current.AuthTokenHash != dev.AuthTokenHash {
			deviceCredentialError(w)
			return
		}
		JSONError(w, http.StatusInternalServerError, "Could not load this Luna's connection. Try again.")
		return
	}
	dev.TunnelID = tunnelID

	out := map[string]any{
		"device_id":       dev.ID,
		"bound":           true,
		"backup_unlocked": unlocked,
		"paired":          true,
	}
	if wanIP := ClientIP(r); wanIP != "" {
		out["wan_ip"] = wanIP
	}
	if sub.Valid && sub.String != "" {
		out["subdomain"] = sub.String
		out["hostname"] = domainname.Hostname(sub.String, config.C.Server.PublicZone)
		out["tunnel_id"] = dev.TunnelID
		tok := ""
		if sealed.Valid && sealed.String != "" {
			opened, err := security.OpenString(sealed.String)
			if err != nil {
				// Hostname/DNS can exist while Luna has no usable token → Cloudflare Error 1033.
				slog.Error("device status: tunnel token decrypt failed; regenerating tunnel",
					"device_id", dev.ID, "subdomain", sub.String, "err", err)
				if healed, st, msg := regenerateDeviceTunnel(h.Deps, dev.ID, dev); st == 200 {
					if t, ok := healed["tunnel_token"].(string); ok {
						tok = t
					}
					if tid, ok := healed["tunnel_id"].(string); ok {
						out["tunnel_id"] = tid
					}
				} else {
					slog.Error("device status: tunnel regenerate failed",
						"device_id", dev.ID, "status", st, "msg", msg)
				}
			} else if opened == "" {
				slog.Error("device status: tunnel token decrypted empty; regenerating tunnel",
					"device_id", dev.ID, "subdomain", sub.String)
				if healed, st, msg := regenerateDeviceTunnel(h.Deps, dev.ID, dev); st == 200 {
					if t, ok := healed["tunnel_token"].(string); ok {
						tok = t
					}
					if tid, ok := healed["tunnel_id"].(string); ok {
						out["tunnel_id"] = tid
					}
				} else {
					slog.Error("device status: tunnel regenerate failed",
						"device_id", dev.ID, "status", st, "msg", msg)
				}
			} else {
				tok = opened
			}
		} else {
			slog.Error("device status: hostname set but tunnel token missing; regenerating tunnel",
				"device_id", dev.ID, "subdomain", sub.String)
			if healed, st, msg := regenerateDeviceTunnel(h.Deps, dev.ID, dev); st == 200 {
				if t, ok := healed["tunnel_token"].(string); ok {
					tok = t
				}
				if tid, ok := healed["tunnel_id"].(string); ok {
					out["tunnel_id"] = tid
				}
			} else {
				slog.Error("device status: tunnel regenerate failed",
					"device_id", dev.ID, "status", st, "msg", msg)
			}
		}
		if tok != "" {
			out["tunnel_token"] = tok
		} else {
			out["tunnel_token_missing"] = true
		}
	}
	JSON(w, http.StatusOK, out)
}

func (h DeviceHandler) Domain(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	expected, ok := DeviceFrom(r.Context())
	if !ok {
		deviceCredentialError(w)
		return
	}
	var req struct {
		Subdomain string `json:"subdomain"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	sub := domainname.Normalize(req.Subdomain)
	if msg := domainname.Validate(sub); msg != "" {
		JSONError(w, http.StatusBadRequest, msg)
		return
	}
	dev, err := revalidateDeviceAuth(h.DB, expected)
	if err != nil {
		writeDeviceAuthError(w, err)
		return
	}
	// Moving an address drives the shared Cloudflare token, so one account
	// cannot loop it. Choosing the first address is setup and is not counted.
	if dev.Subdomain != "" && sub != dev.Subdomain && !allowDomainChange(h.DB, dev.AccountID.String) {
		JSONError(w, http.StatusTooManyRequests, domainChangeMsg)
		return
	}
	out, status, msg := moveDeviceDomain(h.Deps, dev, sub)
	if msg != "" {
		JSONError(w, status, msg)
		return
	}
	JSON(w, status, out)
}

func (h DeviceHandler) Unregister(w http.ResponseWriter, r *http.Request) {
	// Luna-local disconnect uses the same atomic unbind as the account route.
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not linked to Luna Connect. Pair it again in Settings → Luna Connect.")
		return
	}
	if dev.AccountID.Valid && dev.AccountID.String != "" {
		if err := unbindDevice(h.Deps, dev, dev.AccountID.String); err != nil {
			if errors.Is(err, errInvalidDeviceCredential) || errors.Is(err, errDeviceUnbound) || errors.Is(err, errDeviceRevoked) || errors.Is(err, sql.ErrNoRows) {
				deviceCredentialError(w)
				return
			}
			JSONError(w, http.StatusInternalServerError, "Could not disconnect this Luna. Try again.")
			return
		}
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// insertDeviceIdentity mints a factory or DIY device token. Only its hash and a
// short non-secret hint are stored, so the token is returned here once and
// Connect can never show it again.
func insertDeviceIdentity(db deviceExecer, kind, orderRef string) (id, token string, err error) {
	token = security.DeviceToken()
	id = security.NewID("dev")
	_, err = db.Exec(`INSERT INTO devices (
 id, code_hash, code_hint, state, kind, order_ref, local_port, created_at
) VALUES (?, ?, ?, 'unbound', ?, ?, 8090, ?)`,
		id, security.HashToken(token), security.TokenHint(token), kind, nullIfEmpty(orderRef), time.Now().Unix())
	if err != nil {
		return "", "", err
	}
	return id, token, nil
}

// insertDeviceBatch mints count devices in one transaction, so a failure part
// way through leaves no device whose token was never returned.
func insertDeviceBatch(db *database.DB, kind, orderRef string, count int) (ids, tokens []string, err error) {
	tx, err := db.Begin()
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback() }()
	for i := 0; i < count; i++ {
		id, token, err := insertDeviceIdentity(tx, kind, orderRef)
		if err != nil {
			return nil, nil, err
		}
		ids = append(ids, id)
		tokens = append(tokens, token)
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	return ids, tokens, nil
}

// deviceExecer is satisfied by *database.DB and *database.Tx.
type deviceExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
