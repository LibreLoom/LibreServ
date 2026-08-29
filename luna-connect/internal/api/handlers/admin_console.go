package handlers

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

type AdminConsoleHandler struct {
	Deps
}

func (h AdminConsoleHandler) Stats(w http.ResponseWriter, r *http.Request) {
	var accounts, devices, tokensIssued, tokensUnclaimed int64
	var backupBytes int64
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM accounts`).Scan(&accounts)
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&devices)
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM issued_tokens WHERE kind = 'official'`).Scan(&tokensIssued)
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM issued_tokens WHERE kind = 'official' AND status = 'issued'`).Scan(&tokensUnclaimed)
	_ = h.DB.QueryRow(`SELECT COALESCE(SUM(size), 0) FROM backup_objects`).Scan(&backupBytes)
	JSON(w, http.StatusOK, map[string]any{
		"accounts":         accounts,
		"devices":          devices,
		"tokens_issued":    tokensIssued,
		"tokens_unclaimed": tokensUnclaimed,
		"backup_bytes":     backupBytes,
		"estimated_month":  billing.EstimateUSD(backupBytes),
	})
}

func (h AdminConsoleHandler) Devices(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(`
SELECT d.id, COALESCE(d.name, ''), d.subdomain, d.account_id, COALESCE(a.email, ''), d.created_at
FROM devices d
LEFT JOIN accounts a ON a.id = d.account_id
ORDER BY d.created_at DESC`)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list devices.")
		return
	}
	defer rows.Close()
	zone := config.C.Server.PublicZone
	list := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, sub string
		var accountID sql.NullString
		var email string
		var created int64
		if err := rows.Scan(&id, &name, &sub, &accountID, &email, &created); err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not list devices.")
			return
		}
		acctID := ""
		if accountID.Valid {
			acctID = accountID.String
		}
		list = append(list, map[string]any{
			"id":            id,
			"name":          name,
			"subdomain":     sub,
			"hostname":      sub + "." + zone,
			"account_id":    acctID,
			"account_email": email,
			"created_at":    created,
		})
	}
	JSON(w, http.StatusOK, map[string]any{"devices": list})
}

func (h AdminConsoleHandler) Accounts(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(`
SELECT a.id, a.email, a.has_card, a.billing_status, a.created_at,
  (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id) AS device_count
FROM accounts a
ORDER BY a.created_at DESC`)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list accounts.")
		return
	}
	defer rows.Close()
	list := make([]map[string]any, 0)
	for rows.Next() {
		var id, email, billingStatus string
		var hasCard, created, deviceCount int64
		if err := rows.Scan(&id, &email, &hasCard, &billingStatus, &created, &deviceCount); err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not list accounts.")
			return
		}
		list = append(list, map[string]any{
			"id":             id,
			"email":          email,
			"has_card":       hasCard == 1,
			"billing_status": billingStatus,
			"device_count":   deviceCount,
			"created_at":     created,
		})
	}
	JSON(w, http.StatusOK, map[string]any{"accounts": list})
}

func (h AdminConsoleHandler) SetupTokens(w http.ResponseWriter, r *http.Request) {
	all := strings.EqualFold(r.URL.Query().Get("all"), "1") ||
		strings.EqualFold(r.URL.Query().Get("all"), "true") ||
		r.URL.Query().Get("all") == "yes"

	q := `
SELECT t.id, t.kind, t.status, COALESCE(t.token_hint, ''), t.account_id, COALESCE(a.email, ''),
  t.claimed_device_id, COALESCE(d.name, ''), COALESCE(d.subdomain, ''), t.expires_at, t.created_at
FROM issued_tokens t
LEFT JOIN devices d ON d.id = t.claimed_device_id
LEFT JOIN accounts a ON a.id = COALESCE(t.account_id, d.account_id)
ORDER BY t.created_at DESC`
	if !all {
		q += "\nLIMIT 500"
	}
	rows, err := h.DB.Query(q)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list setup codes.")
		return
	}
	defer rows.Close()
	zone := config.C.Server.PublicZone
	list := make([]map[string]any, 0)
	for rows.Next() {
		var id, kind, status, hint, email, deviceName, subdomain string
		var accountID, claimedDevice sql.NullString
		var expires sql.NullInt64
		var created int64
		if err := rows.Scan(&id, &kind, &status, &hint, &accountID, &email, &claimedDevice, &deviceName, &subdomain, &expires, &created); err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not list setup codes.")
			return
		}
		acctID := ""
		if accountID.Valid {
			acctID = accountID.String
		}
		devID := ""
		if claimedDevice.Valid {
			devID = claimedDevice.String
		}
		hostname := ""
		if subdomain != "" {
			hostname = subdomain + "." + zone
		}
		var exp any
		if expires.Valid && expires.Int64 > 0 {
			exp = expires.Int64
		} else {
			exp = nil
		}
		list = append(list, map[string]any{
			"id":                id,
			"kind":              kind,
			"status":            status,
			"hint":              hint,
			"account_id":        acctID,
			"account_email":     email,
			"claimed_device_id": devID,
			"device_name":       deviceName,
			"device_hostname":   hostname,
			"expires_at":        exp,
			"created_at":        created,
			"can_revoke":        status == "issued",
		})
	}
	JSON(w, http.StatusOK, map[string]any{
		"tokens": list,
		"limited": !all,
		"limit":   500,
	})
}

func (h AdminConsoleHandler) RevokeSetupToken(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "tokenID"))
	if id == "" {
		JSONError(w, http.StatusBadRequest, "Setup code id is required.")
		return
	}
	var hash, status string
	err := h.DB.QueryRow(`SELECT token_hash, status FROM issued_tokens WHERE id = ?`, id).Scan(&hash, &status)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "That setup code was not found.")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not revoke that setup code. Try again.")
		return
	}
	if status != "issued" {
		JSONError(w, http.StatusConflict, "Only unused setup codes can be revoked.")
		return
	}
	res, err := h.DB.Exec(`UPDATE issued_tokens SET status = 'revoked' WHERE id = ? AND status = 'issued'`, id)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not revoke that setup code. Try again.")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		JSONError(w, http.StatusConflict, "Only unused setup codes can be revoked.")
		return
	}
	_, _ = h.DB.Exec(`UPDATE setup_sessions SET status = 'replaced' WHERE token_hash = ? AND status IN ('waiting_device','attached')`, hash)
	JSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "status": "revoked"})
}
