package handlers

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
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

func (h DeviceHandler) Register(w http.ResponseWriter, r *http.Request) {
	JSONError(w, http.StatusGone, "Luna no longer creates a remote address by itself. Open connect.luna.libreloom.org, type the device code, and pick a name there.")
}

// Bind attaches an unbound permanent device to the signed-in account (offline).
func (h DeviceHandler) Bind(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	norm := security.NormalizeToken(req.Code)
	if norm == "" || !security.IsOfficialShape(norm) {
		JSONError(w, http.StatusBadRequest, "Type the full device code (****-****-****-****-****).")
		return
	}
	if !allowGuess(h.DB, clientKeyIP(r), 8, 15*60) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
		return
	}
	if !allowGuess(h.DB, clientKeyAccount(acct.ID), 20, 3600) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries on this account. Wait a bit, then try again.")
		return
	}
	var n int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE account_id = ?`, acct.ID).Scan(&n)
	if n >= MaxDevicesPerAccount {
		JSONError(w, http.StatusConflict, "This account already has a Luna. Unbind it first if you want to connect a different one.")
		return
	}
	hash := security.HashToken(norm)
	var id string
	var account sql.NullString
	var revoked int
	err := h.DB.QueryRow(`SELECT id, account_id, revoked FROM devices WHERE code_hash = ?`, hash).
		Scan(&id, &account, &revoked)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "That device code is wrong or unknown. Check the code that came with your Luna, or the code from this website.")
		return
	}
	if revoked != 0 {
		JSONError(w, http.StatusBadRequest, "That device code was revoked. Contact support if this is your Luna.")
		return
	}
	if account.Valid && account.String != "" {
		if account.String == acct.ID {
			JSON(w, http.StatusOK, map[string]any{"device_id": id, "already_bound": true})
			return
		}
		JSONError(w, http.StatusConflict, "That Luna is already linked to another account. The owner must unbind it first.")
		return
	}
	_, err = h.DB.Exec(`UPDATE devices SET account_id = ? WHERE id = ? AND (account_id IS NULL OR account_id = '')`, acct.ID, id)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not link this Luna. Try again.")
		return
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_step = CASE WHEN onboarding_step IS NULL OR onboarding_step IN ('verify','bind','diy-code','code') THEN 'domain' ELSE onboarding_step END WHERE id = ?`, acct.ID)
	JSON(w, http.StatusOK, map[string]any{"device_id": id, "already_bound": false})
}

// Unbind clears the account link, frees the domain, archives backup bindings.
// The permanent device row (code) remains.
func (h DeviceHandler) Unbind(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	id := chi.URLParam(r, "deviceID")
	var d Device
	var account sql.NullString
	var sub, tunnelID sql.NullString
	err := h.DB.QueryRow(`SELECT id, account_id, COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(name,'') FROM devices WHERE id = ?`, id).
		Scan(&d.ID, &account, &sub, &tunnelID, &d.Name)
	if err != nil || !account.Valid || account.String != acct.ID {
		JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		return
	}
	d.AccountID = account
	d.Subdomain = sub.String
	d.TunnelID = tunnelID.String
	unbindDevice(h.Deps, d, acct.ID)
	obPath := acct.OnboardingPath
	if obPath == "" {
		obPath = "official"
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_step = ? WHERE id = ?`, defaultCodeStep(obPath), acct.ID)
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func unbindDevice(deps Deps, d Device, accountID string) {
	providers.RefreshCloudflare()
	if deps.Tunnel != nil && d.TunnelID != "" {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, d.TunnelID)
	}
	if deps.DNS != nil && d.Subdomain != "" {
		_ = deps.DNS.DeleteRecord(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, domainname.Hostname(d.Subdomain, config.C.Server.PublicZone))
	}
	now := time.Now().Unix()
	archiveKey := d.ID + "-" + security.RandomHex(4)
	_, _ = deps.DB.Exec(`UPDATE backup_bindings SET status = 'archived', archived_at = ?, archive_key = ? WHERE account_id = ? AND device_id = ? AND status = 'active'`,
		now, archiveKey, accountID, d.ID)
	_, _ = deps.DB.Exec(`UPDATE devices SET account_id = NULL, subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL WHERE id = ?`, d.ID)
}

// SetDomain provisions tunnel+DNS for a bound device (account-side).
func (h DeviceHandler) SetDomain(w http.ResponseWriter, r *http.Request) {
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
	err := h.DB.QueryRow(`SELECT account_id FROM devices WHERE id = ?`, id).Scan(&account)
	if err != nil || !account.Valid || account.String != acct.ID {
		JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		return
	}
	out, status, msg := applyDeviceDomain(h.Deps, id, req.Subdomain, req.LocalPort)
	if msg != "" {
		JSONError(w, status, msg)
		return
	}
	if status == http.StatusCreated {
		_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_step = CASE WHEN onboarding_step IS NULL OR onboarding_step IN ('verify','bind','domain') THEN 'backup' ELSE onboarding_step END WHERE id = ?`, acct.ID)
	}
	JSON(w, status, out)
}

// Status is called by Luna with Bearer = full device code.
// 200 bound (with tunnel/domain when set); 403 unbound.
func (h DeviceHandler) Status(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
		return
	}
	if !dev.AccountID.Valid || dev.AccountID.String == "" {
		JSONError(w, http.StatusForbidden, "unbound")
		return
	}
	now := time.Now().Unix()
	touchLastSeen(h.DB, dev.ID, now)

	if portHeader := r.Header.Get("X-Luna-Local-Port"); portHeader != "" {
		if port, err := strconv.Atoi(portHeader); err == nil {
			syncDeviceLocalPort(h.Deps, dev.ID, port)
		}
	}

	unlocked := false
	var hasCard int
	var status string
	_ = h.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE id = ?`, dev.AccountID.String).Scan(&hasCard, &status)
	unlocked = billing.BackupsUnlocked(hasCard == 1, status)

	var sealed sql.NullString
	var sub sql.NullString
	_ = h.DB.QueryRow(`SELECT subdomain, tunnel_token, tunnel_id FROM devices WHERE id = ?`, dev.ID).
		Scan(&sub, &sealed, &dev.TunnelID)

	out := map[string]any{
		"device_id":       dev.ID,
		"bound":           true,
		"backup_unlocked": unlocked,
		"paired":          true,
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
				if healed, st, msg := regenerateDeviceTunnel(h.Deps, dev.ID); st == 200 {
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
				if healed, st, msg := regenerateDeviceTunnel(h.Deps, dev.ID); st == 200 {
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
			if healed, st, msg := regenerateDeviceTunnel(h.Deps, dev.ID); st == 200 {
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
	providers.RefreshCloudflare()
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
		return
	}
	if !dev.AccountID.Valid {
		JSONError(w, http.StatusForbidden, "unbound")
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
	if sub == dev.Subdomain {
		JSON(w, http.StatusOK, map[string]any{"hostname": domainname.Hostname(sub, config.C.Server.PublicZone)})
		return
	}
	var exists int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE subdomain = ? AND id != ?`, sub, dev.ID).Scan(&exists)
	if exists > 0 {
		JSONError(w, http.StatusConflict, "That name is already in use. Pick another.")
		return
	}
	var tunnelID, sealed string
	var port int
	_ = h.DB.QueryRow(`SELECT COALESCE(tunnel_id,''), COALESCE(tunnel_token,''), local_port FROM devices WHERE id = ?`, dev.ID).Scan(&tunnelID, &sealed, &port)
	token, err := security.OpenString(sealed)
	if err != nil || tunnelID == "" {
		JSONError(w, http.StatusConflict, "Pick a name on the Luna Connect website first.")
		return
	}
	oldHost := domainname.Hostname(dev.Subdomain, config.C.Server.PublicZone)
	newHost := domainname.Hostname(sub, config.C.Server.PublicZone)
	_ = h.DNS.DeleteRecord(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, oldHost)
	if err := h.Tunnel.ConfigureIngress(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tunnelID, newHost, "http://127.0.0.1:"+itoa(port)); err != nil {
		JSONError(w, http.StatusBadGateway, "Could not move the address. Try again.")
		return
	}
	if err := h.DNS.UpsertCNAME(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, newHost, tunnelID+".cfargotunnel.com"); err != nil {
		JSONError(w, http.StatusBadGateway, "Could not publish the new address. Try again.")
		return
	}
	_, _ = h.DB.Exec(`UPDATE devices SET subdomain = ?, name = ? WHERE id = ?`, sub, sub, dev.ID)
	JSON(w, http.StatusOK, map[string]any{"hostname": newHost, "subdomain": sub, "tunnel_token": token})
}

func (h DeviceHandler) FirstUserUsed(w http.ResponseWriter, r *http.Request) {
	if _, ok := DeviceFrom(r.Context()); !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h DeviceHandler) Unregister(w http.ResponseWriter, r *http.Request) {
	// Luna-local deactivate: same as unbind if bound; never delete the permanent code row.
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
		return
	}
	if dev.AccountID.Valid && dev.AccountID.String != "" {
		unbindDevice(h.Deps, dev, dev.AccountID.String)
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h DeviceHandler) DeviceAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := security.BearerToken(r.Header.Get("Authorization"))
		norm := security.NormalizeToken(tok)
		if norm == "" {
			JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
			return
		}
		var d Device
		var account sql.NullString
		var sub, tunnelID, name sql.NullString
		var revoked int
		err := h.DB.QueryRow(`SELECT id, account_id, COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(name,''), code_hash, kind, revoked FROM devices WHERE code_hash = ?`,
			security.HashToken(norm)).Scan(&d.ID, &account, &sub, &tunnelID, &name, &d.CodeHash, &d.Kind, &revoked)
		if err != nil || revoked != 0 {
			JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
			return
		}
		d.AccountID = account
		d.Subdomain = sub.String
		d.TunnelID = tunnelID.String
		d.Name = name.String
		next.ServeHTTP(w, r.WithContext(WithDevice(r.Context(), d)))
	})
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

// insertPermanentDevice creates an unbound device with the given plaintext code.
func insertPermanentDevice(db *database.DB, kind, code, orderRef string) (id, grouped string, err error) {
	norm := security.NormalizeToken(code)
	if !security.IsOfficialShape(norm) {
		code = security.OfficialDeviceToken()
		norm = security.NormalizeToken(code)
	}
	grouped = security.GroupCrockford(norm)
	sealed, sealErr := security.SealString(grouped)
	if sealErr != nil {
		sealed = ""
	}
	id = security.NewID("dev")
	_, err = db.Exec(`INSERT INTO devices (id, code_hash, code_hint, code_sealed, kind, order_ref, local_port, created_at)
VALUES (?, ?, ?, ?, ?, ?, 8090, ?)`, id, security.HashToken(norm), security.TokenHint(norm), sealed, kind, nullIfEmpty(orderRef), time.Now().Unix())
	return id, grouped, err
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
