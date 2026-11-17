package handlers

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/accounts"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
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

	// device_backup_buckets is deliberately NOT deleted: the "Backups stay"
	// contract keeps stored packs and records, and they are only reachable
	// through the recorded bucket name/id/keys. Dropping the mapping would
	// orphan the paid bucket and let EnsureDeviceBucket silently provision a
	// new empty one on the next read.
	if _, err := deps.DB.Exec(`DELETE FROM devices WHERE id = ?`, deviceID); err != nil {
		return err
	}
	return nil
}

// unlinkDeviceFromAccount frees a Luna from its account and tears down its
// tunnel and address, but keeps the device token row.
func unlinkDeviceFromAccount(deps Deps, deviceID string) error {
	var account sql.NullString
	var sub, tunnelID, name string
	err := deps.DB.QueryRow(`
SELECT account_id, COALESCE(subdomain, ''), COALESCE(tunnel_id, ''), COALESCE(name, '')
FROM devices WHERE id = ?`, deviceID).Scan(&account, &sub, &tunnelID, &name)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	unbindDevice(deps, Device{ID: deviceID, AccountID: account, Subdomain: sub, TunnelID: tunnelID, Name: name}, account.String)
	return nil
}

func teardownDeviceRemote(deps Deps, subdomain, tunnelID string) {
	providers.RefreshCloudflare()
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

// deleteCustomerAccount unlinks every Luna (their device tokens stay), clears
// sign-in sessions and billing metadata, deletes the account's cloud storage and
// removes the account row.
func deleteCustomerAccount(deps Deps, accountID string) error {
	var subID string
	err := deps.DB.QueryRow(`SELECT COALESCE(stripe_subscription_id, '') FROM accounts WHERE id = ?`, accountID).Scan(&subID)
	if err == sql.ErrNoRows {
		return sql.ErrNoRows
	}
	if err != nil {
		return err
	}
	// Stop the cloud backup bill first, charging the month so far: once the
	// account row is gone nothing would ever cancel it. The subscription ends
	// FinalChargeDelay from now so Stripe has processed this last usage report;
	// Stripe then finalizes its final invoice by itself. If Stripe can't be
	// reached, nothing is deleted and the admin can try again.
	if subID != "" {
		if _, _, ok := billing.ReportAccountUsage(deps.DB, accountID); !ok {
			slog.Warn("delete account: could not report this month's usage; the final bill uses the last hourly report", "account", accountID)
		}
		if _, err := billing.ScheduleFinalCharge(subID); err != nil {
			return fmt.Errorf("end cloud backup subscription: %w", err)
		}
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

	// A device token belongs to the Luna, not the account: unlink each Luna
	// (tunnel, DNS, account link) but keep its token so it can be linked again.
	for _, id := range deviceIDs {
		if err := unlinkDeviceFromAccount(deps, id); err != nil {
			return err
		}
	}

	return accounts.PurgeStorageAnd(context.Background(), deps.DB, deps.Store, accountID, func(tx *database.Tx) error {
		for _, table := range []string{"sessions", "oss_payments", "billing_storage_samples", "billing_period_egress"} {
			if _, err := tx.Exec(`DELETE FROM `+table+` WHERE account_id = ?`, accountID); err != nil {
				return err
			}
		}
		_, err := tx.Exec(`DELETE FROM accounts WHERE id = ?`, accountID)
		return err
	})
}
