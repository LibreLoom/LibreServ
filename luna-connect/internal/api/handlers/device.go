package handlers

import (
	"encoding/json"
	"net/http"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
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

func (h DeviceHandler) Register(w http.ResponseWriter, r *http.Request) {
	JSONError(w, http.StatusGone, "Luna no longer creates a remote address by itself. Open connect.luna.libreloom.org, type the device code (****-****-****-****-****), and pick a name there.")
}

func (h DeviceHandler) Domain(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
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
	_ = h.DB.QueryRow(`SELECT tunnel_id, tunnel_token, local_port FROM devices WHERE id = ?`, dev.ID).Scan(&tunnelID, &sealed, &port)
	token, err := security.OpenString(sealed)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not read the protected connection. Ask the person who looks after this Luna Connect site.")
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
	_, _ = h.DB.Exec(`UPDATE devices SET subdomain = ? WHERE id = ?`, sub, dev.ID)
	JSON(w, http.StatusOK, map[string]any{"hostname": newHost, "subdomain": sub, "tunnel_token": token})
}

func (h DeviceHandler) Status(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
		return
	}
	unlocked := false
	if dev.AccountID.Valid {
		var hasCard int
		var status string
		_ = h.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE id = ?`, dev.AccountID.String).Scan(&hasCard, &status)
		unlocked = billing.BackupsUnlocked(hasCard == 1, status)
	}
	JSON(w, http.StatusOK, map[string]any{
		"device_id":       dev.ID,
		"hostname":        domainname.Hostname(dev.Subdomain, config.C.Server.PublicZone),
		"subdomain":       dev.Subdomain,
		"tunnel_id":       dev.TunnelID,
		"backup_unlocked": unlocked,
		"paired":          dev.AccountID.Valid,
	})
}

func (h DeviceHandler) FirstUserUsed(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
		return
	}
	_, _ = h.DB.Exec(`UPDATE devices SET setup_secret = NULL WHERE id = ?`, dev.ID)
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h DeviceHandler) Unregister(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
		return
	}
	teardownDevice(h.Deps, dev)
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// teardownDevice removes the Cloudflare tunnel, public DNS name, and devices
// row. Backup objects stay so a seller can still download billed copies.
func teardownDevice(deps Deps, d Device) {
	if deps.Tunnel != nil && d.TunnelID != "" {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, d.TunnelID)
	}
	if deps.DNS != nil && d.Subdomain != "" {
		_ = deps.DNS.DeleteRecord(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, domainname.Hostname(d.Subdomain, config.C.Server.PublicZone))
	}
	if deps.DB != nil && d.ID != "" {
		_, _ = deps.DB.Exec(`DELETE FROM devices WHERE id = ?`, d.ID)
	}
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
