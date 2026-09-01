package handlers

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type AdminConsoleHandler struct {
	Deps
}

func (h AdminConsoleHandler) Stats(w http.ResponseWriter, r *http.Request) {
	var accounts, devices, unbound, revoked int64
	var backupBytes int64
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM accounts`).Scan(&accounts)
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&devices)
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE (account_id IS NULL OR account_id = '') AND revoked = 0`).Scan(&unbound)
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE revoked != 0`).Scan(&revoked)
	_ = h.DB.QueryRow(`SELECT COALESCE(SUM(size), 0) FROM backup_objects`).Scan(&backupBytes)
	JSON(w, http.StatusOK, map[string]any{
		"accounts":         accounts,
		"devices":          devices,
		"tokens_issued":    devices,
		"tokens_unclaimed": unbound,
		"tokens_revoked":   revoked,
		"backup_bytes":     backupBytes,
		"estimated_month":  billing.EstimateUSD(backupBytes),
	})
}

func (h AdminConsoleHandler) Devices(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(`
SELECT d.id, COALESCE(d.name, ''), COALESCE(d.subdomain, ''), d.account_id, COALESCE(a.email, ''), d.created_at,
  COALESCE(d.code_hint, ''), d.kind, COALESCE(d.last_seen_at, 0), d.revoked
FROM devices d
LEFT JOIN accounts a ON a.id = d.account_id
ORDER BY d.created_at DESC`)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list devices.")
		return
	}
	defer rows.Close()
	zone := config.C.Server.PublicZone
	now := time.Now().Unix()
	list := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, sub, email, hint, kind string
		var accountID sql.NullString
		var created, lastSeen int64
		var revoked int
		if err := rows.Scan(&id, &name, &sub, &accountID, &email, &created, &hint, &kind, &lastSeen, &revoked); err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not list devices.")
			return
		}
		acctID := ""
		if accountID.Valid {
			acctID = accountID.String
		}
		hostname := ""
		if sub != "" {
			hostname = sub + "." + zone
		}
		list = append(list, map[string]any{
			"id":            id,
			"name":          name,
			"subdomain":     sub,
			"hostname":      hostname,
			"account_id":    acctID,
			"account_email": email,
			"code_hint":     hint,
			"kind":          kind,
			"last_seen_at":  lastSeen,
			"online":        lastSeen > 0 && now-lastSeen <= OnlineWithinSec,
			"revoked":       revoked != 0,
			"created_at":    created,
		})
	}
	JSON(w, http.StatusOK, map[string]any{"devices": list})
}

func (h AdminConsoleHandler) Accounts(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(`
SELECT a.id, a.email, a.has_card, a.billing_status, a.email_verified, a.created_at,
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
		var hasCard, emailVerified, created, deviceCount int64
		if err := rows.Scan(&id, &email, &hasCard, &billingStatus, &emailVerified, &created, &deviceCount); err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not list accounts.")
			return
		}
		list = append(list, map[string]any{
			"id":             id,
			"email":          email,
			"has_card":       hasCard == 1,
			"billing_status": billingStatus,
			"email_verified": emailVerified == 1,
			"device_count":   deviceCount,
			"created_at":     created,
		})
	}
	JSON(w, http.StatusOK, map[string]any{"accounts": list})
}

// GetAccount returns one customer account with linked Lunas (device tokens).
func (h AdminConsoleHandler) GetAccount(w http.ResponseWriter, r *http.Request) {
	accountID := strings.TrimSpace(chi.URLParam(r, "accountID"))
	if accountID == "" {
		JSONError(w, http.StatusBadRequest, "Account id is required.")
		return
	}

	var email, billingStatus string
	var hasCard, emailVerified, created int64
	err := h.DB.QueryRow(`
SELECT email, has_card, billing_status, email_verified, created_at
FROM accounts WHERE id = ?`, accountID).
		Scan(&email, &hasCard, &billingStatus, &emailVerified, &created)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "That customer account was not found.")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not load that customer account.")
		return
	}

	devices, err := h.listAccountDevices(accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not load Lunas for this account.")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"id":             accountID,
		"email":          email,
		"has_card":       hasCard == 1,
		"billing_status": billingStatus,
		"email_verified": emailVerified == 1,
		"created_at":     created,
		"devices":        devices,
	})
}

func (h AdminConsoleHandler) listAccountDevices(accountID string) ([]map[string]any, error) {
	rows, err := h.DB.Query(`
SELECT d.id, COALESCE(d.name, ''), COALESCE(d.subdomain, ''), COALESCE(d.code_hint, ''), d.kind,
  COALESCE(d.last_seen_at, 0), d.revoked, d.created_at, COALESCE(d.order_ref, '')
FROM devices d
WHERE d.account_id = ?
ORDER BY d.created_at DESC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	zone := config.C.Server.PublicZone
	now := time.Now().Unix()
	list := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, sub, hint, kind, orderRef string
		var lastSeen, created int64
		var revoked int
		if err := rows.Scan(&id, &name, &sub, &hint, &kind, &lastSeen, &revoked, &created, &orderRef); err != nil {
			return nil, err
		}
		status := "bound"
		if revoked != 0 {
			status = "revoked"
		}
		hostname := ""
		if sub != "" {
			hostname = sub + "." + zone
		}
		list = append(list, map[string]any{
			"id":              id,
			"name":            name,
			"subdomain":       sub,
			"device_hostname": hostname,
			"hint":            hint,
			"kind":            kind,
			"status":          status,
			"order_ref":       orderRef,
			"last_seen_at":    lastSeen,
			"online":          lastSeen > 0 && now-lastSeen <= OnlineWithinSec,
			"created_at":      created,
		})
	}
	return list, nil
}

// SetupTokens lists permanent device codes for support / print (replaces issued_tokens admin UI).
func (h AdminConsoleHandler) SetupTokens(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	all := strings.EqualFold(r.URL.Query().Get("all"), "1") ||
		strings.EqualFold(r.URL.Query().Get("all"), "true")

	query := `
SELECT d.id, d.kind, CASE WHEN d.revoked != 0 THEN 'revoked' WHEN d.account_id IS NOT NULL AND d.account_id != '' THEN 'bound' ELSE 'unbound' END,
  COALESCE(d.code_hint, ''), d.account_id, COALESCE(a.email, ''), COALESCE(d.subdomain, ''), COALESCE(d.order_ref, ''), d.created_at,
  COALESCE(d.code_sealed, '')
FROM devices d
LEFT JOIN accounts a ON a.id = d.account_id
WHERE 1=1`
	args := []any{}
	if q = strings.TrimSpace(q); q != "" {
		query += ` AND (d.code_hint LIKE ? OR d.order_ref LIKE ? OR a.email LIKE ? OR d.id LIKE ?)`
		like := "%" + q + "%"
		args = append(args, like, like, like, like)
	}
	query += ` ORDER BY d.created_at DESC`
	if !all {
		query += ` LIMIT 500`
	}
	rows, err := h.DB.Query(query, args...)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list device codes.")
		return
	}
	defer rows.Close()
	zone := config.C.Server.PublicZone
	list := make([]map[string]any, 0)
	for rows.Next() {
		var id, kind, status, hint, email, subdomain, orderRef, sealed string
		var accountID sql.NullString
		var created int64
		if err := rows.Scan(&id, &kind, &status, &hint, &accountID, &email, &subdomain, &orderRef, &created, &sealed); err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not list device codes.")
			return
		}
		acctID := ""
		if accountID.Valid {
			acctID = accountID.String
		}
		hostname := ""
		if subdomain != "" {
			hostname = subdomain + "." + zone
		}
		item := map[string]any{
			"id":              id,
			"kind":            kind,
			"status":          status,
			"hint":            hint,
			"account_id":      acctID,
			"account_email":   email,
			"device_hostname": hostname,
			"order_ref":       orderRef,
			"created_at":      created,
			"can_revoke":      status == "unbound",
			"setup_prefix":    "",
		}
		if sealed != "" {
			if code, err := security.OpenString(sealed); err == nil && code != "" {
				item["code"] = code
				item["setup_prefix"] = security.SetupPrefix(code)
			}
		}
		list = append(list, item)
	}
	JSON(w, http.StatusOK, map[string]any{
		"tokens":  list,
		"limited": !all,
		"limit":   500,
	})
}

func (h AdminConsoleHandler) RevokeSetupToken(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "tokenID"))
	if id == "" {
		JSONError(w, http.StatusBadRequest, "Device code id is required.")
		return
	}
	var account sql.NullString
	var revoked int
	err := h.DB.QueryRow(`SELECT account_id, revoked FROM devices WHERE id = ?`, id).Scan(&account, &revoked)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "That device code was not found.")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not revoke that device code. Try again.")
		return
	}
	if revoked != 0 {
		JSONError(w, http.StatusConflict, "That device code is already revoked.")
		return
	}
	if account.Valid && account.String != "" {
		JSONError(w, http.StatusConflict, "Unbind this Luna from its account before revoking the code.")
		return
	}
	_, err = h.DB.Exec(`UPDATE devices SET revoked = 1 WHERE id = ?`, id)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not revoke that device code. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "status": "revoked"})
}
