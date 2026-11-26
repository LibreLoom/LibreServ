package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

// Revoke is the account's emergency invalidation action. Unlike unbind, the
// account link remains so the owner can recover the Luna with password step-up.
func (h DeviceHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok || !acct.EmailVerified {
		JSONError(w, http.StatusForbidden, "Verify your email address to continue.")
		return
	}
	d, found, err := loadAccountDevice(h.DB, chi.URLParam(r, "deviceID"), acct.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not revoke this Luna. Try again.")
		return
	}
	if !found {
		JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		return
	}
	if d.State == "revoked" {
		JSON(w, http.StatusOK, map[string]any{"ok": true, "id": d.ID, "status": "revoked"})
		return
	}
	if d.State == "unbound" {
		JSONError(w, http.StatusConflict, "That Luna is not linked to this account.")
		return
	}
	if err := revokeDevice(h.Deps, d, acct.ID); err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not revoke this Luna. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "id": d.ID, "status": "revoked"})
}

func loadAccountDevice(db *database.DB, deviceID, accountID string) (Device, bool, error) {
	var d Device
	var account, sub, tunnelID, name, state sql.NullString
	err := db.QueryRow(`SELECT id, account_id, COALESCE(subdomain,''), COALESCE(tunnel_id,''),
 COALESCE(name,''), COALESCE(state,'unbound') FROM devices WHERE id = ?`, deviceID).
		Scan(&d.ID, &account, &sub, &tunnelID, &name, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, false, nil
	}
	if err != nil {
		return Device{}, false, err
	}
	if !account.Valid || account.String != accountID {
		return Device{}, false, nil
	}
	d.AccountID = account
	d.Subdomain = sub.String
	d.TunnelID = tunnelID.String
	d.Name = name.String
	d.State = state.String
	return d, true, nil
}

// Recover moves a revoked device back to pairing after the account owner enters
// their current password. Luna still has to claim with its device token.
func (h DeviceHandler) Recover(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	acct, ok := AccountFrom(r.Context())
	if !ok || !acct.EmailVerified {
		JSONError(w, http.StatusForbidden, "Verify your email address to continue.")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "Enter your account password to recover this Luna.")
		return
	}
	email := strings.ToLower(strings.TrimSpace(acct.Email))
	ip := ClientIP(r)
	if authBlocked(h.DB, ip, email, authAttemptMax, authAttemptWindow) {
		JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
		return
	}
	accountKey := signInAccountKey("customer", email)
	accountCapped := guessBlocked(h.DB, accountKey, signInAccountAttemptMax, signInAccountAttemptWindow)
	var hash string
	err := h.DB.QueryRow(`SELECT password_hash FROM accounts WHERE id = ?`, acct.ID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		_ = auth.VerifyDummyPassword(req.Password)
	}
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		if accountCapped {
			JSONError(w, http.StatusTooManyRequests, "Too many tries from this network. Wait a few minutes, then try again.")
			return
		}
		_ = allowAuthAttempt(h.DB, ip, email, authAttemptMax, authAttemptWindow)
		_ = allowGuess(h.DB, accountKey, signInAccountAttemptMax, signInAccountAttemptWindow)
		JSONError(w, http.StatusForbidden, "That password is wrong. This Luna was not recovered.")
		return
	}
	clearSignInAccountAttempts(h.DB, accountKey)

	pairingID, status, err := recoverDevicePairing(r.Context(), h.DB, chi.URLParam(r, "deviceID"), acct.ID, time.Now().Unix())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not recover this Luna. Try again.")
		return
	}
	if status == http.StatusNotFound {
		JSONError(w, status, "That Luna is not on this account.")
		return
	}
	if status != http.StatusOK {
		JSONError(w, status, "This Luna cannot be recovered with the pairing details on file. Contact support.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"pairing_id": pairingID})
}

func recoverDevicePairing(ctx context.Context, db *database.DB, deviceID, accountID string, now int64) (string, int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", 0, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := database.LockDevice(tx, deviceID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", http.StatusNotFound, nil
		}
		return "", 0, err
	}
	var owner, state, tokenHash string
	err = tx.QueryRow(`SELECT COALESCE(account_id,''), COALESCE(state,''), COALESCE(code_hash,'')
FROM devices WHERE id = ?`, deviceID).Scan(&owner, &state, &tokenHash)
	if errors.Is(err, sql.ErrNoRows) || owner != accountID {
		return "", http.StatusNotFound, nil
	}
	if err != nil {
		return "", 0, err
	}
	if state != "revoked" {
		return "", http.StatusConflict, nil
	}
	if tokenHash == "" {
		return "", http.StatusConflict, nil
	}
	pairingID := security.NewID("pair")
	res, err := tx.Exec(`UPDATE devices SET state = 'pairing', revoked = 0,
 auth_token_hash = NULL, auth_token_sealed = NULL,
 previous_auth_token_hash = NULL, previous_auth_token_valid_until = NULL,
 subdomain = NULL, tunnel_id = NULL, tunnel_token = NULL, name = NULL, local_port = 8090,
 last_seen_at = NULL, last_public_ip = NULL, last_public_ip_at = NULL
 WHERE id = ? AND account_id = ? AND state = 'revoked'`, deviceID, accountID)
	if err != nil {
		return "", 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return "", 0, err
	}
	if n != 1 {
		return "", http.StatusConflict, nil
	}
	if _, err := tx.Exec(`DELETE FROM device_pairings WHERE device_id = ?`, deviceID); err != nil {
		return "", 0, err
	}
	_, err = tx.Exec(`INSERT INTO device_pairings (id, device_id, account_id, created_at, expires_at)
VALUES (?, ?, ?, ?, ?)`, pairingID, deviceID, accountID, now, now+int64(pairingLifetime/time.Second))
	if err != nil {
		return "", 0, err
	}
	_, _ = tx.Exec(`UPDATE accounts SET onboarding_step = 'pair' WHERE id = ?`, accountID)
	if err := tx.Commit(); err != nil {
		return "", 0, err
	}
	committed = true
	return pairingID, http.StatusOK, nil
}
