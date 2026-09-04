package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func (h AdminConsoleHandler) GetDevice(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(chi.URLParam(r, "deviceID"))
	if deviceID == "" {
		JSONError(w, http.StatusBadRequest, "Luna id is required.")
		return
	}
	detail, err := h.loadDeviceDetail(deviceID)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "That Luna was not found.")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not load that Luna.")
		return
	}
	JSON(w, http.StatusOK, detail)
}

func (h AdminConsoleHandler) RegenerateDeviceTunnel(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(chi.URLParam(r, "deviceID"))
	if deviceID == "" {
		JSONError(w, http.StatusBadRequest, "Luna id is required.")
		return
	}
	out, status, msg := regenerateDeviceTunnel(h.Deps, deviceID)
	if msg != "" {
		JSONError(w, status, msg)
		return
	}
	JSON(w, status, out)
}

func (h AdminConsoleHandler) SetDeviceDomain(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(chi.URLParam(r, "deviceID"))
	if deviceID == "" {
		JSONError(w, http.StatusBadRequest, "Luna id is required.")
		return
	}
	var req struct {
		Subdomain string `json:"subdomain"`
		LocalPort int    `json:"local_port"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	out, status, msg := applyDeviceDomain(h.Deps, deviceID, req.Subdomain, req.LocalPort)
	if msg != "" {
		JSONError(w, status, msg)
		return
	}
	JSON(w, status, out)
}

func (h AdminConsoleHandler) loadDeviceDetail(deviceID string) (map[string]any, error) {
	var id, name, sub, tunnelID, hint, kind, orderRef, sealed string
	var accountID sql.NullString
	var accountEmail sql.NullString
	var lastSeen, created int64
	var revoked int
	err := h.DB.QueryRow(`
SELECT d.id, COALESCE(d.name, ''), COALESCE(d.subdomain, ''), COALESCE(d.tunnel_id, ''), COALESCE(d.code_hint, ''),
  d.kind, COALESCE(d.order_ref, ''), d.account_id, COALESCE(a.email, ''), COALESCE(d.last_seen_at, 0), d.revoked, d.created_at,
  COALESCE(d.code_sealed, '')
FROM devices d
LEFT JOIN accounts a ON a.id = d.account_id
WHERE d.id = ?`, deviceID).
		Scan(&id, &name, &sub, &tunnelID, &hint, &kind, &orderRef, &accountID, &accountEmail, &lastSeen, &revoked, &created, &sealed)
	if err != nil {
		return nil, err
	}

	zone := config.C.Server.PublicZone
	now := time.Now().Unix()
	hostname := ""
	if sub != "" {
		hostname = domainname.Hostname(sub, zone)
	}
	acctID := ""
	if accountID.Valid {
		acctID = accountID.String
	}
	email := ""
	if accountEmail.Valid {
		email = accountEmail.String
	}
	status := "bound"
	if revoked != 0 {
		status = "revoked"
	} else if acctID == "" {
		status = "unbound"
	}
	online := lastSeen > 0 && now-lastSeen <= OnlineWithinSec
	hasTunnel := tunnelID != ""

	out := map[string]any{
		"id":              id,
		"name":            name,
		"subdomain":       sub,
		"device_hostname": hostname,
		"hostname":        hostname,
		"tunnel_id":       tunnelID,
		"has_tunnel":      hasTunnel,
		"hint":            hint,
		"kind":            kind,
		"status":          status,
		"order_ref":       orderRef,
		"account_id":      acctID,
		"account_email":   email,
		"last_seen_at":    lastSeen,
		"online":          online,
		"revoked":         revoked != 0,
		"created_at":      created,
	}
	if sealed != "" {
		if code, err := security.OpenString(sealed); err == nil && code != "" {
			out["code"] = code
			out["setup_prefix"] = security.SetupPrefix(code)
		}
	}
	return out, nil
}

func deviceListFields(id, name, sub, tunnelID, hint, kind, orderRef string, lastSeen, created int64, revoked int, zone string, now int64) map[string]any {
	status := "bound"
	if revoked != 0 {
		status = "revoked"
	}
	hostname := ""
	if sub != "" {
		hostname = domainname.Hostname(sub, zone)
	}
	hasTunnel := tunnelID != ""
	online := lastSeen > 0 && now-lastSeen <= OnlineWithinSec
	return map[string]any{
		"id":              id,
		"name":            name,
		"subdomain":       sub,
		"device_hostname": hostname,
		"tunnel_id":       tunnelID,
		"has_tunnel":      hasTunnel,
		"hint":            hint,
		"kind":            kind,
		"status":          status,
		"order_ref":       orderRef,
		"last_seen_at":    lastSeen,
		"online":          online,
		"revoked":         revoked != 0,
		"created_at":      created,
	}
}
