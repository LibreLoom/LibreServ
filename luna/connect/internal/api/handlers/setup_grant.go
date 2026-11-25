package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

const setupGrantLifetime = 10 * time.Minute

// IssueSetupGrant creates the only current grant for this account and device.
// Replacing the row invalidates every previously issued grant, used or not.
func (h DeviceHandler) IssueSetupGrant(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	acct, ok := AccountFrom(r.Context())
	if !ok || !acct.EmailVerified {
		JSONError(w, http.StatusForbidden, "Verify your email address to continue.")
		return
	}
	deviceID := chi.URLParam(r, "deviceID")
	tx, err := h.DB.BeginTx(r.Context(), nil)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create a setup link. Try again.")
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := database.LockDevice(tx, deviceID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		} else {
			JSONError(w, http.StatusInternalServerError, "Could not create a setup link. Try again.")
		}
		return
	}
	var owner, state, subdomain string
	err = tx.QueryRow(`SELECT COALESCE(account_id,''), COALESCE(state,''), COALESCE(subdomain,'')
FROM devices WHERE id = ?`, deviceID).Scan(&owner, &state, &subdomain)
	if err != nil || owner != acct.ID || state != "bound" {
		JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		return
	}
	grant := security.SetupGrant()
	now := time.Now().Unix()
	_, err = tx.Exec(`INSERT INTO device_setup_grants (device_id, account_id, token_hash, expires_at, used_at)
VALUES (?, ?, ?, ?, NULL)
ON CONFLICT(device_id) DO UPDATE SET account_id = excluded.account_id,
 token_hash = excluded.token_hash, expires_at = excluded.expires_at, used_at = NULL`,
		deviceID, acct.ID, security.HashToken(grant), now+int64(setupGrantLifetime/time.Second))
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create a setup link. Try again.")
		return
	}
	if err := tx.Commit(); err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create a setup link. Try again.")
		return
	}
	committed = true
	out := map[string]any{"setup_grant": grant}
	if subdomain != "" {
		out["setup_url"] = "https://" + domainname.Hostname(subdomain, config.C.Server.PublicZone) + "/setup#setup_grant=" + grant
	}
	JSON(w, http.StatusOK, out)
}

// ConsumeSetupGrant is called by Luna with its current auth token immediately
// before creating the first local Admin. The update itself fences replay.
func (h DeviceHandler) ConsumeSetupGrant(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	dev, ok := DeviceFrom(r.Context())
	if !ok || !dev.AccountID.Valid || dev.AccountID.String == "" {
		JSONError(w, http.StatusUnauthorized, "This Luna is not linked to Luna Connect.")
		return
	}
	var req struct {
		SetupGrant string `json:"setup_grant"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !security.ValidAuthToken(req.SetupGrant) {
		JSONError(w, http.StatusBadRequest, "That setup link is no longer valid. Create a new one in Luna Connect.")
		return
	}
	now := time.Now().Unix()
	consumed, err := consumeSetupGrant(r.Context(), h.DB, dev, req.SetupGrant, now)
	if errors.Is(err, errInvalidDeviceCredential) || errors.Is(err, errDeviceUnbound) || errors.Is(err, errDeviceRevoked) {
		writeDeviceAuthError(w, err)
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not check the setup link. Try again.")
		return
	}
	if !consumed {
		JSONError(w, http.StatusBadRequest, "That setup link is no longer valid. Create a new one in Luna Connect.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func consumeSetupGrant(ctx context.Context, db *database.DB, expected Device, grant string, now int64) (bool, error) {
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
	current, err := lockDeviceAuth(tx, expected)
	if err != nil {
		return false, err
	}
	res, err := tx.Exec(`UPDATE device_setup_grants SET used_at = ?
WHERE device_id = ? AND account_id = ? AND token_hash = ? AND used_at IS NULL AND expires_at > ?
  AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND account_id = ? AND state = 'bound' AND auth_token_hash = ?)`,
		now, current.ID, current.AccountID.String, security.HashToken(grant), now,
		current.ID, current.AccountID.String, current.AuthTokenHash)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	committed = true
	return n == 1, nil
}
