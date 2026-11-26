package handlers

import (
	"database/sql"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

type accountDeviceState struct {
	accountID sql.NullString
	state     string
	authHash  string
	subdomain string
	tunnelID  string
}

// lockAccountDevice re-reads the owner, credential, and remote fields under the
// device lock. Callers never tear down or clear a newer account's tunnel using a
// snapshot captured before an unbind/revoke/re-pair.
func lockAccountDevice(tx *database.Tx, d Device, accountID string) (accountDeviceState, error) {
	var current accountDeviceState
	if err := database.LockDevice(tx, d.ID); err != nil {
		return current, err
	}
	if err := tx.QueryRow(`SELECT account_id, COALESCE(state,'unbound'), COALESCE(auth_token_hash,''),
       COALESCE(subdomain,''), COALESCE(tunnel_id,'') FROM devices WHERE id = ?`, d.ID).
		Scan(&current.accountID, &current.state, &current.authHash, &current.subdomain, &current.tunnelID); err != nil {
		return current, err
	}
	if !current.accountID.Valid || current.accountID.String == "" || current.accountID.String != accountID {
		return current, sql.ErrNoRows
	}
	if d.State != "" && current.state != d.State {
		return current, sql.ErrNoRows
	}
	if d.AuthTokenHash != "" && current.authHash != d.AuthTokenHash {
		return current, errInvalidDeviceCredential
	}
	return current, nil
}

func accountDeviceUpdateFence(d Device, accountID string) (string, []any) {
	query := ` WHERE id = ? AND account_id = ?`
	args := []any{d.ID, accountID}
	if d.State != "" {
		query += ` AND state = ?`
		args = append(args, d.State)
	}
	if d.AuthTokenHash != "" {
		query += ` AND auth_token_hash = ?`
		args = append(args, d.AuthTokenHash)
	}
	return query, args
}

// unbindDevice invalidates the rolling credential before tearing down remote
// access. The public UID and reusable verification code stay on the device row.
func unbindDevice(deps Deps, d Device, accountID string) error {
	providers.RefreshCloudflare()
	tx, err := deps.DB.Begin()
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	current, err := lockAccountDevice(tx, d, accountID)
	if err != nil {
		return err
	}
	if err := reserveDeviceDomains(tx, d.ID, accountID, current.subdomain); err != nil {
		return err
	}
	// Keep the latest token hashes as non-authenticating tombstones so a retry
	// after a lost response can identify the unbound state. Re-pairing clears
	// them before issuing the next credential.
	fence, fenceArgs := accountDeviceUpdateFence(d, accountID)
	args := append([]any{"unbound", 0}, fenceArgs...)
	res, err := tx.Exec(`UPDATE devices SET state = ?, revoked = ?, account_id = NULL,
  subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL,
  local_port = 8090, last_seen_at = NULL, last_public_ip = NULL, last_public_ip_at = NULL,
  setup_secret = NULL, auth_token_sealed = NULL, previous_auth_token_valid_until = NULL`+fence, args...)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return sql.ErrNoRows
	}
	if _, err := tx.Exec(`DELETE FROM device_pairings WHERE device_id = ?`, d.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM device_setup_grants WHERE device_id = ?`, d.ID); err != nil {
		return err
	}
	// Keep the device fence through provider teardown. Re-pairing cannot publish
	// the same hostname while the old DNS deletion is still in flight.
	teardownDeviceRemoteWithConfig(deps, current.subdomain, current.tunnelID)
	if err := releaseDomainReservationForSub(tx, current.subdomain, d.ID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// revokeDevice keeps the account link for account-authorized recovery, but
// immediately invalidates every usable credential and all remote access.
func revokeDevice(deps Deps, d Device, accountID string) error {
	providers.RefreshCloudflare()
	tx, err := deps.DB.Begin()
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	current, err := lockAccountDevice(tx, d, accountID)
	if err != nil {
		return err
	}
	if err := reserveDeviceDomains(tx, d.ID, accountID, current.subdomain); err != nil {
		return err
	}
	// Retain the latest hashes as tombstones so DeviceAuth can report the
	// revoked state to a credential that was valid before this transition.
	fence, fenceArgs := accountDeviceUpdateFence(d, accountID)
	args := append([]any{"revoked"}, fenceArgs...)
	res, err := tx.Exec(`UPDATE devices SET state = ?, revoked = 1,
  subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL,
  local_port = 8090, last_seen_at = NULL, last_public_ip = NULL, last_public_ip_at = NULL,
  setup_secret = NULL, auth_token_sealed = NULL, previous_auth_token_valid_until = NULL`+fence, args...)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return sql.ErrNoRows
	}
	if _, err := tx.Exec(`DELETE FROM device_pairings WHERE device_id = ?`, d.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM device_setup_grants WHERE device_id = ?`, d.ID); err != nil {
		return err
	}
	teardownDeviceRemoteWithConfig(deps, current.subdomain, current.tunnelID)
	if err := releaseDomainReservationForSub(tx, current.subdomain, d.ID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}
