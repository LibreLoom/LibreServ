package handlers

import (
	"database/sql"
	"log/slog"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type boundDeviceDomain struct {
	ID        string
	AccountID string
	Subdomain string
	TunnelID  string
	Sealed    string
	Port      int
}

func loadBoundDeviceDomain(db *sql.DB, deviceID string) (boundDeviceDomain, int, string) {
	var d boundDeviceDomain
	var account sql.NullString
	var curSub, tunnelID, sealed sql.NullString
	var port int
	err := db.QueryRow(`SELECT account_id, COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(tunnel_token,''), local_port FROM devices WHERE id = ?`, deviceID).
		Scan(&account, &curSub, &tunnelID, &sealed, &port)
	if err == sql.ErrNoRows {
		return d, 404, "That Luna was not found."
	}
	if err != nil {
		return d, 500, "Could not load that Luna."
	}
	if !account.Valid || account.String == "" {
		return d, 404, "That Luna is not linked to a customer account."
	}
	d.ID = deviceID
	d.AccountID = account.String
	d.Subdomain = curSub.String
	d.TunnelID = tunnelID.String
	d.Sealed = sealed.String
	if port <= 0 {
		port = 8090
	}
	d.Port = port
	return d, 0, ""
}

func cloudflareDomainReady() (int, string) {
	if !config.C.Cloudflare.Ready() && !config.DevMode() {
		return 503, "Remote addresses need Cloudflare tunnel and DNS keys. Add them in Admin → Connections, or in the Luna Connect config file (cloudflare.account_id, api_token, zone_id)."
	}
	if err := security.AtRestReady(); err != nil {
		slog.Error("domain ops: at-rest key not configured", "error", err)
		return 503, "Could not protect the connection secret. Try again."
	}
	return 0, ""
}

// applyDeviceDomain provisions tunnel+DNS for a bound device (same logic as account SetDomain).
func applyDeviceDomain(deps Deps, deviceID, sub string, port int) (map[string]any, int, string) {
	providers.RefreshCloudflare()
	sub = domainname.Normalize(sub)
	if msg := domainname.Validate(sub); msg != "" {
		return nil, 400, msg
	}
	if port <= 0 {
		port = 8090
	}

	d, status, msg := loadBoundDeviceDomain(deps.DB, deviceID)
	if status != 0 {
		return nil, status, msg
	}

	if d.Subdomain == sub && d.TunnelID != "" {
		host := domainname.Hostname(sub, config.C.Server.PublicZone)
		out := map[string]any{"hostname": host, "subdomain": sub, "device_id": deviceID}
		if d.Sealed != "" {
			if tok, err := security.OpenString(d.Sealed); err == nil {
				out["tunnel_token"] = tok
			}
		}
		return out, 200, ""
	}

	var exists int
	_ = deps.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE subdomain = ? AND id != ?`, sub, deviceID).Scan(&exists)
	if exists > 0 {
		return nil, 409, "That name is already in use. Pick another."
	}
	if status, msg := cloudflareDomainReady(); status != 0 {
		return nil, status, msg
	}

	host := domainname.Hostname(sub, config.C.Server.PublicZone)
	if d.TunnelID != "" {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, d.TunnelID)
	}
	if d.Subdomain != "" {
		_ = deps.DNS.DeleteRecord(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, domainname.Hostname(d.Subdomain, config.C.Server.PublicZone))
	}

	creds, err := deps.Tunnel.CreateTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, "luna-"+sub)
	if err != nil {
		return nil, 502, "Could not create the secure connection. Try again."
	}
	tid, ttoken := creds.TunnelID, creds.Token
	if err := deps.Tunnel.ConfigureIngress(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid, host, "http://127.0.0.1:"+itoa(port)); err != nil {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid)
		return nil, 502, "Could not set up the address. Try again."
	}
	if err := deps.DNS.UpsertCNAME(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, host, tid+".cfargotunnel.com"); err != nil {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid)
		return nil, 502, "Could not publish the address. Try again."
	}
	sealedTok, err := security.SealString(ttoken)
	if err != nil {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid)
		_ = deps.DNS.DeleteRecord(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, host)
		return nil, 500, "Could not protect the connection secret. Try again."
	}
	_, err = deps.DB.Exec(`UPDATE devices SET subdomain = ?, tunnel_id = ?, tunnel_token = ?, local_port = ?, name = ? WHERE id = ?`,
		sub, tid, sealedTok, port, sub, deviceID)
	if err != nil {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid)
		_ = deps.DNS.DeleteRecord(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, host)
		return nil, 500, "Could not save the address. Try again."
	}
	return map[string]any{
		"device_id": deviceID, "hostname": host, "subdomain": sub,
		"tunnel_token": ttoken,
	}, 201, ""
}

// regenerateDeviceTunnel deletes the old Cloudflare tunnel and creates a new one for the same subdomain.
func regenerateDeviceTunnel(deps Deps, deviceID string) (map[string]any, int, string) {
	providers.RefreshCloudflare()
	d, status, msg := loadBoundDeviceDomain(deps.DB, deviceID)
	if status != 0 {
		return nil, status, msg
	}
	if d.Subdomain == "" {
		return nil, 409, "This Luna has no address yet. Set an address first."
	}
	if status, msg := cloudflareDomainReady(); status != 0 {
		return nil, status, msg
	}

	host := domainname.Hostname(d.Subdomain, config.C.Server.PublicZone)
	if d.TunnelID != "" {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, d.TunnelID)
	}

	creds, err := deps.Tunnel.CreateTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, "luna-"+d.Subdomain)
	if err != nil {
		return nil, 502, "Could not create the secure connection. Try again."
	}
	tid, ttoken := creds.TunnelID, creds.Token
	if err := deps.Tunnel.ConfigureIngress(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid, host, "http://127.0.0.1:"+itoa(d.Port)); err != nil {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid)
		return nil, 502, "Could not set up the secure connection. Try again."
	}
	if err := deps.DNS.UpsertCNAME(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, host, tid+".cfargotunnel.com"); err != nil {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid)
		return nil, 502, "Could not publish the address. Try again."
	}
	sealedTok, err := security.SealString(ttoken)
	if err != nil {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid)
		return nil, 500, "Could not protect the connection secret. Try again."
	}
	_, err = deps.DB.Exec(`UPDATE devices SET tunnel_id = ?, tunnel_token = ? WHERE id = ?`, tid, sealedTok, deviceID)
	if err != nil {
		_ = deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tid)
		return nil, 500, "Could not save the secure connection. Try again."
	}
	return map[string]any{
		"device_id":   deviceID,
		"hostname":    host,
		"subdomain":   d.Subdomain,
		"tunnel_id":   tid,
		"regenerated": true,
	}, 200, ""
}
