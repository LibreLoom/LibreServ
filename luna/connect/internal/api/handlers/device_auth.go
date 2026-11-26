package handlers

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

const (
	authRefreshAfterSeconds = 300
	authRefreshOverlap      = 60 * time.Second
	deviceActivityDebounce  = 60 * time.Second
	deviceUnboundCode       = "device_unbound"
	deviceRevokedCode       = "device_revoked"
)

var (
	errInvalidDeviceCredential = errors.New("invalid device credential")
	errDeviceUnbound           = errors.New("device unbound")
	errDeviceRevoked           = errors.New("device revoked")
	errCredentialUnavailable   = errors.New("device credential unavailable")
)

func deviceCredentialError(w http.ResponseWriter) {
	JSONError(w, http.StatusUnauthorized, "This Luna is not linked to Luna Connect. Pair it again in Settings → Luna Connect.")
}

func deviceCredentialStateError(w http.ResponseWriter, code string) {
	const message = "This Luna's connection to Luna Connect is no longer active."
	JSON(w, http.StatusForbidden, map[string]string{
		"error":   message,
		"message": message,
		"code":    code,
	})
}

// DeviceAuth accepts only the current rolling credential on normal device
// routes. A previous credential is useful only to classify an unbound or
// revoked tombstone; refreshDeviceToken remains its sole overlap path.
func (h DeviceHandler) DeviceAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := security.BearerToken(r.Header.Get("Authorization"))
		if !security.ValidAuthToken(token) {
			deviceCredentialError(w)
			return
		}
		dev, err := loadDeviceByAuthToken(h.DB, token)
		if errors.Is(err, errDeviceUnbound) {
			deviceCredentialStateError(w, deviceUnboundCode)
			return
		}
		if errors.Is(err, errDeviceRevoked) {
			deviceCredentialStateError(w, deviceRevokedCode)
			return
		}
		if err != nil {
			deviceCredentialError(w)
			return
		}
		observeDeviceActivity(h.DB, dev, ClientIP(r), time.Now().Unix())
		next.ServeHTTP(w, r.WithContext(WithDevice(r.Context(), dev)))
	})
}

func loadDeviceByAuthToken(db *database.DB, token string) (Device, error) {
	var dev Device
	var account, sub, tunnelID, name, kind, state sql.NullString
	var currentHash string
	var lastSeen sql.NullInt64
	hash := security.HashToken(token)
	err := db.QueryRow(`
SELECT id, COALESCE(state,''), account_id,
       COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(name,''), COALESCE(kind,'official'),
       COALESCE(auth_token_hash,''), last_seen_at
FROM devices
WHERE auth_token_hash = ? OR previous_auth_token_hash = ?
LIMIT 1`, hash, hash).
		Scan(&dev.ID, &state, &account, &sub, &tunnelID, &name, &kind, &currentHash, &lastSeen)
	if err != nil {
		return Device{}, errInvalidDeviceCredential
	}
	// Unbind and revocation retain the latest hashes only as tombstones. They
	// cannot authenticate, but let a lost unbind response distinguish a normal
	// disconnect from emergency revocation without putting state in the message.
	switch state.String {
	case "unbound":
		return Device{}, errDeviceUnbound
	case "revoked":
		return Device{}, errDeviceRevoked
	}
	if state.String != "bound" || !account.Valid || account.String == "" || currentHash != hash {
		// A previous credential is accepted only by the refresh endpoint.
		return Device{}, errInvalidDeviceCredential
	}
	dev.State = state.String
	dev.AccountID = account
	dev.AuthTokenHash = currentHash
	dev.Subdomain = sub.String
	dev.TunnelID = tunnelID.String
	dev.Name = name.String
	dev.Kind = kind.String
	dev.LastSeenAt = lastSeen
	return dev, nil
}

type deviceAuthQueryer interface {
	QueryRow(query string, args ...any) *sql.Row
}

// loadCurrentDeviceAuth reads the credential and owner that are current now,
// rather than trusting the snapshot captured by DeviceAuth.
func loadCurrentDeviceAuth(exec deviceAuthQueryer, deviceID string) (Device, error) {
	var dev Device
	var account, sub, tunnelID, name, kind, state sql.NullString
	var lastSeen sql.NullInt64
	err := exec.QueryRow(`
SELECT id, COALESCE(state,''), account_id,
       COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(name,''), COALESCE(kind,'official'),
       COALESCE(auth_token_hash,''), last_seen_at
FROM devices WHERE id = ?`, deviceID).
		Scan(&dev.ID, &state, &account, &sub, &tunnelID, &name, &kind, &dev.AuthTokenHash, &lastSeen)
	if err != nil {
		return Device{}, errInvalidDeviceCredential
	}
	dev.State = state.String
	dev.AccountID = account
	dev.Subdomain = sub.String
	dev.TunnelID = tunnelID.String
	dev.Name = name.String
	dev.Kind = kind.String
	dev.LastSeenAt = lastSeen
	return dev, nil
}

func validateDeviceAuth(current, expected Device) error {
	if expected.ID == "" || current.ID != expected.ID || expected.AuthTokenHash == "" {
		return errInvalidDeviceCredential
	}
	switch current.State {
	case "unbound":
		if current.AuthTokenHash == expected.AuthTokenHash {
			return errDeviceUnbound
		}
		return errInvalidDeviceCredential
	case "revoked":
		if current.AuthTokenHash == expected.AuthTokenHash {
			return errDeviceRevoked
		}
		return errInvalidDeviceCredential
	}
	if current.State != "bound" || !current.AccountID.Valid || current.AccountID.String == "" ||
		current.AuthTokenHash != expected.AuthTokenHash {
		return errInvalidDeviceCredential
	}
	if expected.State != "" && current.State != expected.State {
		return errInvalidDeviceCredential
	}
	if expected.AccountID.Valid && current.AccountID.String != expected.AccountID.String {
		return errInvalidDeviceCredential
	}
	return nil
}

func revalidateDeviceAuth(db *database.DB, expected Device) (Device, error) {
	if db == nil {
		return Device{}, errInvalidDeviceCredential
	}
	current, err := loadCurrentDeviceAuth(db, expected.ID)
	if err != nil {
		return Device{}, err
	}
	if err := validateDeviceAuth(current, expected); err != nil {
		return Device{}, err
	}
	return current, nil
}

// lockDeviceAuth holds the device row across a sensitive read or final commit.
// Every credential/state transition takes the same lock, so the expected token
// cannot rotate or cross an unbind/re-pair while the caller is inside.
func lockDeviceAuth(tx *database.Tx, expected Device) (Device, error) {
	if tx == nil {
		return Device{}, errInvalidDeviceCredential
	}
	if err := database.LockDevice(tx, expected.ID); err != nil {
		return Device{}, errInvalidDeviceCredential
	}
	current, err := loadCurrentDeviceAuth(tx, expected.ID)
	if err != nil {
		return Device{}, err
	}
	if err := validateDeviceAuth(current, expected); err != nil {
		return Device{}, err
	}
	return current, nil
}

func writeDeviceAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errDeviceUnbound):
		deviceCredentialStateError(w, deviceUnboundCode)
	case errors.Is(err, errDeviceRevoked):
		deviceCredentialStateError(w, deviceRevokedCode)
	default:
		deviceCredentialError(w)
	}
}

func publicClientIP(ip string) string {
	parsed := net.ParseIP(strings.Trim(ip, "[]"))
	if parsed == nil || !parsed.IsGlobalUnicast() || parsed.IsPrivate() || parsed.IsLoopback() || parsed.IsLinkLocalUnicast() {
		return ""
	}
	return parsed.String()
}

func observeDeviceActivity(db *database.DB, dev Device, clientIP string, now int64) {
	if db == nil || dev.ID == "" || dev.AuthTokenHash == "" || !dev.AccountID.Valid {
		return
	}
	ip := publicClientIP(clientIP)
	_, _ = db.Exec(`
UPDATE devices
SET last_seen_at = CASE WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ? ELSE last_seen_at END,
    last_public_ip = CASE WHEN ? != '' THEN ? ELSE last_public_ip END,
    last_public_ip_at = CASE WHEN ? != '' THEN ? ELSE last_public_ip_at END
WHERE id = ? AND account_id = ? AND state = 'bound' AND auth_token_hash = ?`,
		now-int64(deviceActivityDebounce/time.Second), now,
		ip, ip, ip, now, dev.ID, dev.AccountID.String, dev.AuthTokenHash)
}

// RefreshToken rotates the current credential. A retry made with the previous
// credential inside the overlap returns the already-issued current credential,
// rather than rotating it again and losing another response.
func (h DeviceHandler) RefreshToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	token := security.BearerToken(r.Header.Get("Authorization"))
	if !security.ValidAuthToken(token) {
		deviceCredentialError(w)
		return
	}
	rotated, err := refreshDeviceToken(r.Context(), h.DB, token, time.Now().Unix())
	if errors.Is(err, errDeviceUnbound) {
		deviceCredentialStateError(w, deviceUnboundCode)
		return
	}
	if errors.Is(err, errDeviceRevoked) {
		deviceCredentialStateError(w, deviceRevokedCode)
		return
	}
	if errors.Is(err, errInvalidDeviceCredential) {
		deviceCredentialError(w)
		return
	}
	if err != nil {
		JSONError(w, http.StatusServiceUnavailable, "Could not refresh this Luna's connection. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"auth_token":            rotated,
		"refresh_after_seconds": authRefreshAfterSeconds,
	})
}

func refreshDeviceToken(ctx context.Context, db *database.DB, token string, now int64) (string, error) {
	if db == nil || !security.ValidAuthToken(token) {
		return "", errInvalidDeviceCredential
	}
	hash := security.HashToken(token)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	var deviceID string
	err = tx.QueryRow(`
SELECT id FROM devices
WHERE auth_token_hash = ? OR previous_auth_token_hash = ?
LIMIT 1`, hash, hash).Scan(&deviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errInvalidDeviceCredential
	}
	if err != nil {
		return "", err
	}
	if err := database.LockDevice(tx, deviceID); err != nil {
		return "", err
	}

	var state, accountID, currentHash, previousHash, sealed string
	var previousUntil sql.NullInt64
	err = tx.QueryRow(`
SELECT state, COALESCE(account_id,''), COALESCE(auth_token_hash,''),
       COALESCE(previous_auth_token_hash,''), previous_auth_token_valid_until,
       COALESCE(auth_token_sealed,'')
FROM devices WHERE id = ?`, deviceID).
		Scan(&state, &accountID, &currentHash, &previousHash, &previousUntil, &sealed)
	if err != nil {
		return "", err
	}
	switch state {
	case "unbound":
		return "", errDeviceUnbound
	case "revoked":
		return "", errDeviceRevoked
	}
	if state != "bound" || accountID == "" {
		return "", errInvalidDeviceCredential
	}

	if currentHash == hash {
		next := security.AuthToken()
		nextSealed, err := security.SealString(next)
		if err != nil {
			return "", errCredentialUnavailable
		}
		res, err := tx.Exec(`
UPDATE devices SET auth_token_hash = ?, auth_token_sealed = ?,
 previous_auth_token_hash = ?, previous_auth_token_valid_until = ?
WHERE id = ? AND account_id = ? AND state = 'bound' AND auth_token_hash = ?`,
			security.HashToken(next), nextSealed, hash, now+int64(authRefreshOverlap/time.Second), deviceID, accountID, hash)
		if err != nil {
			return "", err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return "", err
		}
		if n != 1 {
			return "", errInvalidDeviceCredential
		}
		if err := tx.Commit(); err != nil {
			return "", err
		}
		committed = true
		return next, nil
	}

	if previousHash != hash || !previousUntil.Valid || previousUntil.Int64 <= now {
		return "", errInvalidDeviceCredential
	}
	current, err := security.OpenString(sealed)
	if err != nil || current == "" || !security.ValidAuthToken(current) || security.HashToken(current) != currentHash {
		if err := tx.Commit(); err != nil {
			return "", err
		}
		committed = true
		return "", errCredentialUnavailable
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	committed = true
	return current, nil
}
