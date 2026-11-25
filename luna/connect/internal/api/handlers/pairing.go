package handlers

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

const (
	pairingLifetime          = 10 * time.Minute
	pairingDeviceFailures    = 5
	pairingAccountFailures   = 20
	pairingIPFailures        = 50
	pairingDeviceIPFailures  = 20
	pairingFailureWindow     = 10 * time.Minute
	pairingAccountWindow     = time.Hour
	pairingPublicIPRecentFor = 10 * time.Minute
)

const genericPairingError = "That Device ID or verification code is wrong or is no longer pairing. Check both and try again."

var (
	errPairingInvalid     = errors.New("invalid pairing")
	errPairingNoAttempt   = errors.New("no active pairing attempt")
	errPairingAccountFull = errors.New("pairing account already has a Luna")
	errPairingRateLimited = errors.New("pairing rate limited")
)

type pairingInput struct {
	DeviceUID        string `json:"device_uid"`
	VerificationCode string `json:"verification_code"`
}

func decodePairingInput(r *http.Request) (pairingInput, bool) {
	var req pairingInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return pairingInput{}, false
	}
	req.DeviceUID = security.NormalizeDeviceUID(req.DeviceUID)
	req.VerificationCode = security.NormalizeVerificationCode(req.VerificationCode)
	if !security.IsDeviceUIDShape(req.DeviceUID) || !security.IsVerificationCodeShape(req.VerificationCode) {
		return pairingInput{}, false
	}
	return req, true
}

type pairingRateContext struct {
	deviceUID      string
	accountID      string
	ip             string
	deviceFailures int
}

func pairingContextForRequest(db *database.DB, req pairingInput, accountID string, r *http.Request, now int64) pairingRateContext {
	ctx := pairingRateContext{
		deviceUID:      req.DeviceUID,
		accountID:      accountID,
		ip:             ClientIP(r),
		deviceFailures: pairingDeviceFailures,
	}
	if db == nil || req.DeviceUID == "" {
		return ctx
	}
	var lastIP string
	var lastIPAt sql.NullInt64
	_ = db.QueryRow(`SELECT COALESCE(last_public_ip,''), last_public_ip_at FROM devices WHERE device_uid = ?`, req.DeviceUID).
		Scan(&lastIP, &lastIPAt)
	if ctx.ip != "" && lastIP != "" && lastIP == ctx.ip && lastIPAt.Valid &&
		lastIPAt.Int64 > 0 && now-lastIPAt.Int64 <= int64(pairingPublicIPRecentFor/time.Second) {
		ctx.deviceFailures = pairingDeviceIPFailures
	}
	if ctx.accountID == "" {
		_ = db.QueryRow(`SELECT account_id FROM device_pairings WHERE device_id = (
  SELECT id FROM devices WHERE device_uid = ?)`, req.DeviceUID).Scan(&ctx.accountID)
	}
	return ctx
}

// refreshPairingRateContext runs after the device lock. The account bucket and
// trusted-IP relaxation therefore describe the attempt being verified, not a
// pairing that existed when the request entered.
func refreshPairingRateContext(tx *database.Tx, deviceID string, rate pairingRateContext, now int64) pairingRateContext {
	var lastIP string
	var lastIPAt sql.NullInt64
	if err := tx.QueryRow(`SELECT COALESCE(last_public_ip,''), last_public_ip_at FROM devices WHERE id = ?`, deviceID).
		Scan(&lastIP, &lastIPAt); err == nil {
		rate.deviceFailures = pairingDeviceFailures
		if rate.ip != "" && lastIP != "" && lastIP == rate.ip && lastIPAt.Valid &&
			lastIPAt.Int64 > 0 && now-lastIPAt.Int64 <= int64(pairingPublicIPRecentFor/time.Second) {
			rate.deviceFailures = pairingDeviceIPFailures
		}
	}
	if rate.accountID == "" {
		_ = tx.QueryRow(`SELECT account_id FROM device_pairings WHERE device_id = ?`, deviceID).Scan(&rate.accountID)
	}
	return rate
}

type pairingRateLimit struct {
	max    int
	window int64
}

func pairingRateLimits(rate pairingRateContext) map[string]pairingRateLimit {
	limits := map[string]pairingRateLimit{}
	if rate.deviceUID != "" {
		limits["pair-device:"+rate.deviceUID] = pairingRateLimit{
			max: rate.deviceFailures, window: int64(pairingFailureWindow / time.Second),
		}
	}
	if rate.accountID != "" {
		limits["pair-account:"+rate.accountID] = pairingRateLimit{
			max: pairingAccountFailures, window: int64(pairingAccountWindow / time.Second),
		}
	}
	if rate.ip != "" {
		limits["pair-ip:"+rate.ip] = pairingRateLimit{
			max: pairingIPFailures, window: int64(pairingFailureWindow / time.Second),
		}
	}
	return limits
}

func pairingRateKeys(rate pairingRateContext) []string {
	keys := []string{}
	if rate.deviceUID != "" {
		keys = append(keys, "pair-device:"+rate.deviceUID)
	}
	if rate.accountID != "" {
		keys = append(keys, "pair-account:"+rate.accountID)
	}
	if rate.ip != "" {
		keys = append(keys, "pair-ip:"+rate.ip)
	}
	return keys
}

// reservePairingRate locks and increments every applicable bucket before the
// verification code is compared. The reservation is refunded for valid pairing
// polls and successful claims, and rolls back with the surrounding transaction
// on any error. Invalid guesses commit the increments.
func reservePairingRate(tx *database.Tx, rate pairingRateContext, now int64) error {
	limits := pairingRateLimits(rate)
	for _, key := range pairingRateKeys(rate) {
		limit := limits[key]
		if _, err := tx.Exec(`INSERT INTO guess_attempts (key, count, start, last) VALUES (?, 0, ?, ?)
ON CONFLICT(key) DO NOTHING`, key, now, now); err != nil {
			return err
		}
		var count, start int64
		query := `SELECT count, start FROM guess_attempts WHERE key = ?`
		if tx.Driver() == database.DriverPostgres {
			query += ` FOR UPDATE`
		} else {
			// SQLite's transaction-wide writer lock is already held by LockDevice.
			_, _ = tx.Exec(`UPDATE guess_attempts SET count = count WHERE key = ?`, key)
		}
		if err := tx.QueryRow(query, key).Scan(&count, &start); err != nil {
			return err
		}
		if now-start >= limit.window {
			if _, err := tx.Exec(`UPDATE guess_attempts SET count = 0, start = ?, last = ? WHERE key = ?`, now, now, key); err != nil {
				return err
			}
			count = 0
		}
		if count >= int64(limit.max) {
			return errPairingRateLimited
		}
		res, err := tx.Exec(`UPDATE guess_attempts SET count = count + 1, last = ? WHERE key = ? AND count < ?`,
			now, key, limit.max)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return errPairingRateLimited
		}
	}
	return nil
}

func refundPairingRate(tx *database.Tx, rate pairingRateContext) error {
	for _, key := range pairingRateKeys(rate) {
		if _, err := tx.Exec(`DELETE FROM guess_attempts WHERE key = ? AND count = 1`, key); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE guess_attempts SET count = count - 1 WHERE key = ? AND count > 1`, key); err != nil {
			return err
		}
	}
	return nil
}

func recordInvalidPairingAttempt(db *database.DB, rate pairingRateContext, now int64) (bool, error) {
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := reservePairingRate(tx, rate, now); err != nil {
		if errors.Is(err, errPairingRateLimited) {
			return false, nil
		}
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	committed = true
	return true, nil
}

func writePairingRateLimit(w http.ResponseWriter) {
	JSONError(w, http.StatusTooManyRequests, "Too many pairing attempts. Wait a few minutes, then try again.")
}

func writePairingInvalid(w http.ResponseWriter) {
	JSONError(w, http.StatusBadRequest, genericPairingError)
}

func writeClaimInvalid(w http.ResponseWriter) {
	// Luna treats 404 as "no pairing is waiting", which keeps ordinary
	// unbound polling quiet. Every invalid claim uses the same generic body.
	JSONError(w, http.StatusNotFound, genericPairingError)
}

// StartPair creates a ten-minute attempt for a verified Connect account. A
// live attempt is idempotent for its owner and is never displaced for another.
func (h DeviceHandler) StartPair(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	if !acct.EmailVerified {
		JSONError(w, http.StatusForbidden, "Verify your email address before pairing a Luna.")
		return
	}
	req, valid := decodePairingInput(r)
	now := time.Now().Unix()
	rate := pairingContextForRequest(h.DB, req, acct.ID, r, now)
	if !valid {
		allowed, err := recordInvalidPairingAttempt(h.DB, rate, now)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not check pairing. Try again.")
			return
		}
		if !allowed {
			writePairingRateLimit(w)
			return
		}
		writePairingInvalid(w)
		return
	}
	pairingID, err := startDevicePairing(r.Context(), h.DB, acct.ID, req, rate, now)
	if errors.Is(err, errPairingAccountFull) {
		JSONError(w, http.StatusConflict, "This account already has a Luna. Unbind it first to pair a different Luna.")
		return
	}
	if errors.Is(err, errPairingRateLimited) {
		writePairingRateLimit(w)
		return
	}
	if errors.Is(err, errPairingInvalid) {
		writePairingInvalid(w)
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not start pairing. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"pairing_id": pairingID})
}

func startDevicePairing(ctx context.Context, db *database.DB, accountID string, req pairingInput, rate pairingRateContext, now int64) (string, error) {
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
	err = tx.QueryRow(`SELECT id FROM devices WHERE device_uid = ?`, req.DeviceUID).Scan(&deviceID)
	if errors.Is(err, sql.ErrNoRows) {
		if err := reservePairingRate(tx, rate, now); err != nil {
			return "", err
		}
		if err := tx.Commit(); err != nil {
			return "", err
		}
		committed = true
		return "", errPairingInvalid
	}
	if err != nil {
		return "", err
	}
	// Device-before-account is the repository-wide order for credential and
	// storage work. StartPair and ClaimPair previously took the inverse order.
	if err := database.LockDevice(tx, deviceID); err != nil {
		return "", err
	}
	rate = refreshPairingRateContext(tx, deviceID, rate, now)
	if err := database.LockStorageAccount(tx, accountID); err != nil {
		return "", err
	}
	if err := reservePairingRate(tx, rate, now); err != nil {
		return "", err
	}

	var state, verificationHash string
	err = tx.QueryRow(`SELECT COALESCE(state,'unbound'), COALESCE(verification_code_hash,'')
FROM devices WHERE id = ?`, deviceID).Scan(&state, &verificationHash)
	if err != nil {
		return "", err
	}
	if subtle.ConstantTimeCompare([]byte(verificationHash), []byte(security.HashToken(req.VerificationCode))) != 1 {
		if err := tx.Commit(); err != nil {
			return "", err
		}
		committed = true
		return "", errPairingInvalid
	}
	if state != "unbound" && state != "pairing" {
		if err := tx.Commit(); err != nil {
			return "", err
		}
		committed = true
		return "", errPairingInvalid
	}

	var existingID string
	var existingAccount string
	var expiresAt int64
	err = tx.QueryRow(`SELECT id, account_id, expires_at FROM device_pairings WHERE device_id = ?`, deviceID).
		Scan(&existingID, &existingAccount, &expiresAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if err == nil && expiresAt > now {
		if existingAccount == accountID {
			if err := refundPairingRate(tx, rate); err != nil {
				return "", err
			}
			if err := tx.Commit(); err != nil {
				return "", err
			}
			committed = true
			return existingID, nil
		}
		if err := tx.Commit(); err != nil {
			return "", err
		}
		committed = true
		return "", errPairingInvalid
	}

	var other int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM devices WHERE account_id = ? AND id != ?`, accountID, deviceID).Scan(&other); err != nil {
		return "", err
	}
	if other >= MaxDevicesPerAccount {
		if err := refundPairingRate(tx, rate); err != nil {
			return "", err
		}
		if err := tx.Commit(); err != nil {
			return "", err
		}
		committed = true
		return "", errPairingAccountFull
	}

	pairingID := security.NewID("pair")
	res, err := tx.Exec(`UPDATE devices SET state = 'pairing', revoked = 0, account_id = ?,
  auth_token_hash = NULL, auth_token_sealed = NULL,
  previous_auth_token_hash = NULL, previous_auth_token_valid_until = NULL,
  subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL, local_port = 8090,
  last_seen_at = NULL, last_public_ip = NULL, last_public_ip_at = NULL, setup_secret = NULL
 WHERE id = ? AND state = ?`, accountID, deviceID, state)
	if err != nil {
		return "", err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return "", err
	}
	if n != 1 {
		return "", errPairingInvalid
	}
	if _, err := tx.Exec(`DELETE FROM device_pairings WHERE device_id = ?`, deviceID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(`DELETE FROM device_setup_grants WHERE device_id = ?`, deviceID); err != nil {
		return "", err
	}
	_, err = tx.Exec(`INSERT INTO device_pairings (id, device_id, account_id, created_at, expires_at)
VALUES (?, ?, ?, ?, ?)`, pairingID, deviceID, accountID, now, now+int64(pairingLifetime/time.Second))
	if err != nil {
		return "", err
	}
	_, _ = tx.Exec(`UPDATE accounts SET onboarding_step = 'pair' WHERE id = ?`, accountID)
	if err := refundPairingRate(tx, rate); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	committed = true
	return pairingID, nil
}

// ClaimPair is Luna's unauthenticated polling/claim route. Possession of the
// reusable code is useful only while an account has a live pairing attempt.
func (h DeviceHandler) ClaimPair(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	req, valid := decodePairingInput(r)
	now := time.Now().Unix()
	rate := pairingContextForRequest(h.DB, req, "", r, now)
	if !valid {
		allowed, err := recordInvalidPairingAttempt(h.DB, rate, now)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not finish pairing. Try again.")
			return
		}
		if !allowed {
			writePairingRateLimit(w)
			return
		}
		writeClaimInvalid(w)
		return
	}
	out, err := claimDevicePairing(r.Context(), h.DB, req, rate, ClientIP(r), now)
	if errors.Is(err, errPairingRateLimited) {
		writePairingRateLimit(w)
		return
	}
	if errors.Is(err, errPairingInvalid) {
		writeClaimInvalid(w)
		return
	}
	if errors.Is(err, errPairingNoAttempt) {
		// Ordinary unbound polling proves the saved pairing material is valid,
		// but there is nothing to claim. Keep the response indistinguishable
		// from invalid material without charging a failed attempt.
		writeClaimInvalid(w)
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not finish pairing. Try again.")
		return
	}
	JSON(w, http.StatusOK, out)
}

func claimDevicePairing(ctx context.Context, db *database.DB, req pairingInput, rate pairingRateContext, clientIP string, now int64) (map[string]any, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	var deviceID string
	if err := tx.QueryRow(`SELECT id FROM devices WHERE device_uid = ?`, req.DeviceUID).Scan(&deviceID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			if err := reservePairingRate(tx, rate, now); err != nil {
				return nil, err
			}
			if err := tx.Commit(); err != nil {
				return nil, err
			}
			committed = true
			return nil, errPairingInvalid
		}
		return nil, err
	}
	if err := database.LockDevice(tx, deviceID); err != nil {
		return nil, err
	}
	rate = refreshPairingRateContext(tx, deviceID, rate, now)
	var attemptAccount string
	_ = tx.QueryRow(`SELECT account_id FROM device_pairings WHERE device_id = ?`, deviceID).Scan(&attemptAccount)
	rate.accountID = attemptAccount
	if rate.accountID != "" {
		if err := database.LockStorageAccount(tx, rate.accountID); err != nil {
			return nil, err
		}
	}
	if err := reservePairingRate(tx, rate, now); err != nil {
		return nil, err
	}

	var state, verificationHash string
	if err := tx.QueryRow(`SELECT COALESCE(state,'unbound'), COALESCE(verification_code_hash,'')
FROM devices WHERE id = ?`, deviceID).Scan(&state, &verificationHash); err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare([]byte(verificationHash), []byte(security.HashToken(req.VerificationCode))) != 1 {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		committed = true
		return nil, errPairingInvalid
	}
	var accountID string
	var expiresAt int64
	err = tx.QueryRow(`SELECT account_id, expires_at FROM device_pairings WHERE device_id = ?`, deviceID).
		Scan(&accountID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		if state == "pairing" {
			_, _ = tx.Exec(`UPDATE devices SET state = 'unbound', account_id = NULL, revoked = 0,
  subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL, local_port = 8090,
  last_seen_at = NULL, last_public_ip = NULL, last_public_ip_at = NULL, setup_secret = NULL
 WHERE id = ? AND state = 'pairing'`, deviceID)
		}
		if state == "unbound" || state == "pairing" {
			if err := refundPairingRate(tx, rate); err != nil {
				return nil, err
			}
			if err := tx.Commit(); err != nil {
				return nil, err
			}
			committed = true
			return nil, errPairingNoAttempt
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		committed = true
		return nil, errPairingInvalid
	}
	if err != nil {
		return nil, err
	}
	if state == "bound" || state == "revoked" {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		committed = true
		return nil, errPairingInvalid
	}
	if state == "unbound" || expiresAt <= now {
		_, _ = tx.Exec(`DELETE FROM device_pairings WHERE device_id = ?`, deviceID)
		_, _ = tx.Exec(`UPDATE devices SET state = 'unbound', account_id = NULL, revoked = 0,
  subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL, local_port = 8090,
  last_seen_at = NULL, last_public_ip = NULL, last_public_ip_at = NULL, setup_secret = NULL
 WHERE id = ? AND state = ?`, deviceID, state)
		if err := refundPairingRate(tx, rate); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		committed = true
		return nil, errPairingNoAttempt
	}
	if state != "pairing" {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		committed = true
		return nil, errPairingInvalid
	}
	var other int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM devices WHERE account_id = ? AND id != ?`, accountID, deviceID).Scan(&other); err != nil {
		return nil, err
	}
	if other >= MaxDevicesPerAccount {
		if err := refundPairingRate(tx, rate); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		committed = true
		return nil, errPairingInvalid
	}

	token := security.AuthToken()
	sealed, err := security.SealString(token)
	if err != nil {
		return nil, errCredentialUnavailable
	}
	res, err := tx.Exec(`UPDATE devices SET state = 'bound', revoked = 0, account_id = ?,
  auth_token_hash = ?, auth_token_sealed = ?,
  previous_auth_token_hash = NULL, previous_auth_token_valid_until = NULL,
  subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL, local_port = 8090,
  last_seen_at = ?, last_public_ip = ?, last_public_ip_at = ?, setup_secret = NULL
 WHERE id = ? AND account_id = ? AND state = 'pairing' AND verification_code_hash = ?`,
		accountID, security.HashToken(token), sealed, now, nullIfEmpty(publicClientIP(clientIP)), now,
		deviceID, accountID, verificationHash)
	if err != nil {
		return nil, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, errPairingInvalid
	}
	if _, err := tx.Exec(`DELETE FROM device_setup_grants WHERE device_id = ?`, deviceID); err != nil {
		return nil, err
	}
	_, _ = tx.Exec(`UPDATE accounts SET onboarding_step = CASE
  WHEN onboarding_step IS NULL OR onboarding_step IN ('verify','bind','diy-code','code','pair') THEN 'domain'
  ELSE onboarding_step END WHERE id = ?`, accountID)
	if err := refundPairingRate(tx, rate); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true
	return map[string]any{
		"auth_token":            token,
		"device_id":             deviceID,
		"refresh_after_seconds": authRefreshAfterSeconds,
	}, nil
}

func (h DeviceHandler) PairStatus(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok || !acct.EmailVerified {
		JSONError(w, http.StatusForbidden, "Verify your email address to continue.")
		return
	}
	status, deviceID, found, err := devicePairingStatus(r.Context(), h.DB, chi.URLParam(r, "pairingID"), acct.ID, time.Now().Unix())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not check pairing. Try again.")
		return
	}
	if !found {
		JSONError(w, http.StatusNotFound, "That pairing attempt was not found.")
		return
	}
	out := map[string]any{"status": status}
	if status == "bound" {
		out["device_id"] = deviceID
	}
	JSON(w, http.StatusOK, out)
}

type lockedPairing struct {
	id        string
	accountID string
	expiresAt int64
	state     string
}

func readLockedPairing(tx *database.Tx, deviceID string) (lockedPairing, bool, error) {
	var pairing lockedPairing
	err := tx.QueryRow(`SELECT p.id, p.account_id, p.expires_at, COALESCE(d.state,'unbound')
FROM device_pairings p JOIN devices d ON d.id = p.device_id WHERE p.device_id = ?`, deviceID).
		Scan(&pairing.id, &pairing.accountID, &pairing.expiresAt, &pairing.state)
	if errors.Is(err, sql.ErrNoRows) {
		return lockedPairing{}, false, nil
	}
	return pairing, err == nil, err
}

func clearUnboundPairing(tx *database.Tx, deviceID string, pairing lockedPairing) error {
	if _, err := tx.Exec(`DELETE FROM device_pairings WHERE id = ? AND device_id = ? AND account_id = ?`,
		pairing.id, deviceID, pairing.accountID); err != nil {
		return err
	}
	_, err := tx.Exec(`UPDATE devices SET state = 'unbound', account_id = NULL, revoked = 0,
  subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL, local_port = 8090,
  last_seen_at = NULL, last_public_ip = NULL, last_public_ip_at = NULL, setup_secret = NULL
 WHERE id = ? AND account_id = ? AND state = 'pairing'`, deviceID, pairing.accountID)
	return err
}

// lockedPairingStatus re-reads the pairing after the device lock. A request
// that saw an expired row before the lock cannot reset a replacement attempt.
func lockedPairingStatus(tx *database.Tx, deviceID, pairingID, accountID string, now int64) (status, foundDeviceID string, found bool, err error) {
	pairing, found, err := readLockedPairing(tx, deviceID)
	if err != nil || !found {
		return "", deviceID, found, err
	}
	if pairing.id != pairingID || pairing.accountID != accountID {
		return "", deviceID, false, nil
	}
	if pairing.state == "bound" {
		return "bound", deviceID, true, nil
	}
	if pairing.expiresAt <= now || pairing.state != "pairing" {
		if err := clearUnboundPairing(tx, deviceID, pairing); err != nil {
			return "", deviceID, false, err
		}
		return "unbound", deviceID, true, nil
	}
	return "waiting", deviceID, true, nil
}

func devicePairingStatus(ctx context.Context, db *database.DB, pairingID, accountID string, now int64) (status, deviceID string, found bool, err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", "", false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	var owner string
	err = tx.QueryRow(`SELECT p.account_id, p.device_id FROM device_pairings p WHERE p.id = ?`, pairingID).
		Scan(&owner, &deviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	if owner != accountID {
		return "", "", false, nil
	}
	if err := database.LockDevice(tx, deviceID); err != nil {
		return "", "", false, err
	}
	status, deviceID, found, err = lockedPairingStatus(tx, deviceID, pairingID, accountID, now)
	if err != nil {
		return "", "", false, err
	}
	if !found {
		return "", "", false, nil
	}
	if err := tx.Commit(); err != nil {
		return "", "", false, err
	}
	committed = true
	return status, deviceID, true, nil
}

// CancelPair lets the account close its own live attempt. Cancellation is an
// account action, not a verification attempt, so it does not consume a failure.
func (h DeviceHandler) CancelPair(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok || !acct.EmailVerified {
		JSONError(w, http.StatusForbidden, "Verify your email address to continue.")
		return
	}
	found, err := cancelDevicePairing(r.Context(), h.DB, chi.URLParam(r, "pairingID"), acct.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not cancel pairing. Try again.")
		return
	}
	if !found {
		JSONError(w, http.StatusNotFound, "That pairing attempt was not found.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func lockedCancelPairing(tx *database.Tx, deviceID, pairingID, accountID string) (bool, error) {
	pairing, found, err := readLockedPairing(tx, deviceID)
	if err != nil || !found {
		return false, err
	}
	if pairing.id != pairingID || pairing.accountID != accountID || pairing.state != "pairing" {
		return false, nil
	}
	if _, err := tx.Exec(`DELETE FROM device_pairings WHERE id = ? AND device_id = ? AND account_id = ?`,
		pairing.id, deviceID, pairing.accountID); err != nil {
		return false, err
	}
	_, err = tx.Exec(`UPDATE devices SET state = 'unbound', account_id = NULL, revoked = 0,
  subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL, local_port = 8090,
  last_seen_at = NULL, last_public_ip = NULL, last_public_ip_at = NULL, setup_secret = NULL
 WHERE id = ? AND account_id = ? AND state = 'pairing'`, deviceID, pairing.accountID)
	return true, err
}

func cancelDevicePairing(ctx context.Context, db *database.DB, pairingID, accountID string) (bool, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	var deviceID, owner string
	err = tx.QueryRow(`SELECT device_id, account_id FROM device_pairings WHERE id = ?`, pairingID).Scan(&deviceID, &owner)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if owner != accountID {
		return false, nil
	}
	if err := database.LockDevice(tx, deviceID); err != nil {
		return false, err
	}
	found, err := lockedCancelPairing(tx, deviceID, pairingID, accountID)
	if err != nil || !found {
		return found, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	committed = true
	return true, nil
}
