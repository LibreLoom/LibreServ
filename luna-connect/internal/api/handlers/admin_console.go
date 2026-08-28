package handlers

import (
	"database/sql"
	"net/http"

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
