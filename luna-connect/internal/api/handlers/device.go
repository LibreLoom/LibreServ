package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

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
	if !h.allowRegister(ClientIP(r)) {
		JSONError(w, http.StatusTooManyRequests, "Too many new Lunas from this network. Try again in an hour.")
		return
	}
	var req struct {
		DeviceName string `json:"device_name"`
		Subdomain  string `json:"subdomain"`
		LocalPort  int    `json:"local_port"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	sub := domainname.Normalize(req.Subdomain)
	if msg := domainname.Validate(sub); msg != "" {
		JSONError(w, http.StatusBadRequest, msg)
		return
	}
	if req.LocalPort <= 0 {
		req.LocalPort = 8090
	}
	if req.DeviceName == "" {
		req.DeviceName = "Luna"
	}
	var exists int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE subdomain = ?`, sub).Scan(&exists)
	if exists > 0 {
		JSONError(w, http.StatusConflict, "That name is already in use. Pick another.")
		return
	}

	hostname := domainname.Hostname(sub, config.C.Server.PublicZone)
	creds, err := h.Tunnel.CreateTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, "luna-"+sub)
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Could not set up the protected connection. Try again in a few minutes.")
		return
	}
	serviceURL := "http://127.0.0.1:" + itoa(req.LocalPort)
	if err := h.Tunnel.ConfigureIngress(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, creds.TunnelID, hostname, serviceURL); err != nil {
		JSONError(w, http.StatusBadGateway, "Could not finish the protected connection. Try again.")
		return
	}
	target := creds.TunnelID + ".cfargotunnel.com"
	if err := h.DNS.UpsertCNAME(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, hostname, target); err != nil {
		JSONError(w, http.StatusBadGateway, "Could not publish the address. Try again.")
		return
	}

	token := security.RandomHex(24)
	id := security.NewID("dev")
	_, err = h.DB.Exec(`INSERT INTO devices (id, token_hash, name, subdomain, tunnel_id, tunnel_token, local_port, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, security.HashToken(token), req.DeviceName, sub, creds.TunnelID, creds.Token, req.LocalPort, time.Now().Unix())
	if err != nil {
		JSONError(w, http.StatusConflict, "That name is already in use. Pick another.")
		return
	}
	JSON(w, http.StatusCreated, map[string]any{
		"device_token": token,
		"device_id":    id,
		"hostname":     hostname,
		"tunnel_token": creds.Token,
		"subdomain":    sub,
	})
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
	var tunnelID, token string
	var port int
	_ = h.DB.QueryRow(`SELECT tunnel_id, tunnel_token, local_port FROM devices WHERE id = ?`, dev.ID).Scan(&tunnelID, &token, &port)
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
		unlocked = hasCard == 1 && (status == "active" || status == "dev")
	}
	var code sql.NullString
	_ = h.DB.QueryRow(`SELECT pairing_code FROM devices WHERE id = ?`, dev.ID).Scan(&code)
	JSON(w, http.StatusOK, map[string]any{
		"device_id":       dev.ID,
		"hostname":        domainname.Hostname(dev.Subdomain, config.C.Server.PublicZone),
		"subdomain":       dev.Subdomain,
		"tunnel_id":       dev.TunnelID,
		"backup_unlocked": unlocked,
		"pairing_code":    code.String,
		"paired":          dev.AccountID.Valid,
	})
}

func (h DeviceHandler) PairingCode(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
		return
	}
	code := strings.ToUpper(security.RandomHex(3))
	exp := time.Now().Add(15 * time.Minute).Unix()
	_, _ = h.DB.Exec(`UPDATE devices SET pairing_code = ?, pairing_expires = ? WHERE id = ?`, code, exp, dev.ID)
	JSON(w, http.StatusOK, map[string]any{"pairing_code": code})
}

func (h DeviceHandler) Unregister(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "This Luna is not signed in to Connect.")
		return
	}
	_ = h.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, dev.TunnelID)
	_ = h.DNS.DeleteRecord(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, domainname.Hostname(dev.Subdomain, config.C.Server.PublicZone))
	_, _ = h.DB.Exec(`DELETE FROM devices WHERE id = ?`, dev.ID)
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h DeviceHandler) allowRegister(ip string) bool {
	now := time.Now().Unix()
	var count, start int64
	err := h.DB.QueryRow(`SELECT count, start FROM register_attempts WHERE ip = ?`, ip).Scan(&count, &start)
	if err != nil {
		_, _ = h.DB.Exec(`INSERT INTO register_attempts (ip, count, start) VALUES (?, 1, ?)`, ip, now)
		return true
	}
	if now-start >= 3600 {
		_, _ = h.DB.Exec(`UPDATE register_attempts SET count = 1, start = ? WHERE ip = ?`, now, ip)
		return true
	}
	if count >= 10 {
		return false
	}
	_, _ = h.DB.Exec(`UPDATE register_attempts SET count = count + 1 WHERE ip = ?`, ip)
	return true
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
