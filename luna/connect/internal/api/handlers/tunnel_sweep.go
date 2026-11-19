package handlers

import (
	"log/slog"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

// siteTunnelName is the tunnel that carries Luna Connect itself. The sweep must never touch it.
const siteTunnelName = "luna-connect"

// orphanTunnelAge keeps the sweep away from a tunnel that is still being set up: it is created
// before its id is saved on the device.
const orphanTunnelAge = time.Hour

// maxSweepDeletes bounds one run, so a surprise (a wrong account, an empty devices table) cannot
// wipe the account.
const maxSweepDeletes = 25

// orphanTunnels picks the tunnels to delete: Luna tunnels (named luna-*) that no device points at.
func orphanTunnels(all []providers.TunnelInfo, owned map[string]bool, now time.Time) []providers.TunnelInfo {
	var out []providers.TunnelInfo
	for _, t := range all {
		if !strings.HasPrefix(t.Name, "luna-") || t.Name == siteTunnelName || owned[t.ID] {
			continue
		}
		if t.CreatedAt.IsZero() || now.Sub(t.CreatedAt) < orphanTunnelAge {
			continue
		}
		out = append(out, t)
	}
	return out
}

// SweepOrphanTunnels deletes Cloudflare tunnels that no Luna owns any more (a delete that failed
// earlier, or a setup that stopped half way). Safe to run often.
func SweepOrphanTunnels(deps Deps) {
	if deps.Tunnel == nil || deps.DB == nil {
		return
	}
	providers.RefreshCloudflare()
	cf := config.Cloudflare()
	if !cf.Ready() {
		return
	}
	rows, err := deps.DB.Query(`SELECT COALESCE(tunnel_id, '') FROM devices`)
	if err != nil {
		slog.Error("tunnel sweep: could not read devices", "err", err)
		return
	}
	owned := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			slog.Error("tunnel sweep: could not read devices", "err", err)
			return
		}
		if id != "" {
			owned[id] = true
		}
	}
	rows.Close()

	all, err := deps.Tunnel.ListTunnels(cf.AccountID, cf.APIToken)
	if err != nil {
		slog.Error("tunnel sweep: could not list tunnels", "err", err)
		return
	}
	orphans := orphanTunnels(all, owned, time.Now())
	if len(orphans) > maxSweepDeletes {
		slog.Error("tunnel sweep: too many orphans, deleting only the first batch", "found", len(orphans), "batch", maxSweepDeletes)
		orphans = orphans[:maxSweepDeletes]
	}
	for _, t := range orphans {
		if err := deps.Tunnel.DeleteTunnel(cf.AccountID, cf.APIToken, t.ID); err != nil {
			slog.Error("tunnel sweep: delete failed", "tunnel", t.Name, "id", t.ID, "err", err)
			continue
		}
		slog.Info("tunnel sweep: deleted an unused tunnel", "tunnel", t.Name, "id", t.ID)
	}
}
