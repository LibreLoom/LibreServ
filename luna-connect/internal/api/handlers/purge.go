package handlers

import (
	"database/sql"
	"log/slog"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
)

// purgeDeviceToken disconnects a Luna from its account, tears down tunnel/DNS,
// archives active backup bindings, and removes the device row. Cloud backup
// objects and archived bindings are kept for retention.
func purgeDeviceToken(deps Deps, deviceID string) error {
	var account sql.NullString
	var sub, tunnelID, name string
	err := deps.DB.QueryRow(`
SELECT account_id, COALESCE(subdomain, ''), COALESCE(tunnel_id, ''), COALESCE(name, '')
FROM devices WHERE id = ?`, deviceID).
		Scan(&account, &sub, &tunnelID, &name)
	if err == sql.ErrNoRows {
		return sql.ErrNoRows
	}
	if err != nil {
		return err
	}

	if account.Valid && account.String != "" {
		unbindDevice(deps, Device{
			ID:        deviceID,
			AccountID: account,
			Subdomain: sub,
			TunnelID:  tunnelID,
			Name:      name,
		}, account.String)
	} else {
		teardownDeviceRemote(deps, sub, tunnelID)
	}

	if _, err := deps.DB.Exec(`DELETE FROM devices WHERE id = ?`, deviceID); err != nil {
		return err
	}
	return nil
}

func teardownDeviceRemote(deps Deps, subdomain, tunnelID string) {
	if deps.Tunnel != nil && tunnelID != "" {
		if err := deps.Tunnel.DeleteTunnel(config.C.Cloudflare.AccountID, config.C.Cloudflare.APIToken, tunnelID); err != nil {
			slog.Warn("purge device: tunnel delete failed", "tunnel_id", tunnelID, "err", err)
		}
	}
	if deps.DNS != nil && subdomain != "" {
		host := domainname.Hostname(subdomain, config.C.Server.PublicZone)
		if err := deps.DNS.DeleteRecord(config.C.Cloudflare.APIToken, config.C.Cloudflare.ZoneID, host); err != nil {
			slog.Warn("purge device: dns delete failed", "host", host, "err", err)
		}
	}
}

// deleteCustomerAccount purges every linked Luna, clears sign-in sessions and
// billing metadata, and removes the account row. Backup objects stay in storage.
func deleteCustomerAccount(deps Deps, accountID string) error {
	var exists int
	if err := deps.DB.QueryRow(`SELECT COUNT(*) FROM accounts WHERE id = ?`, accountID).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return sql.ErrNoRows
	}

	rows, err := deps.DB.Query(`SELECT id FROM devices WHERE account_id = ?`, accountID)
	if err != nil {
		return err
	}
	var deviceIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		deviceIDs = append(deviceIDs, id)
	}
	rows.Close()

	for _, id := range deviceIDs {
		if err := purgeDeviceToken(deps, id); err != nil {
			return err
		}
	}

	_, _ = deps.DB.Exec(`DELETE FROM sessions WHERE account_id = ?`, accountID)
	_, _ = deps.DB.Exec(`DELETE FROM oss_payments WHERE account_id = ?`, accountID)
	_, _ = deps.DB.Exec(`DELETE FROM billing_storage_samples WHERE account_id = ?`, accountID)
	_, _ = deps.DB.Exec(`DELETE FROM billing_period_egress WHERE account_id = ?`, accountID)

	_, err = deps.DB.Exec(`DELETE FROM accounts WHERE id = ?`, accountID)
	return err
}
