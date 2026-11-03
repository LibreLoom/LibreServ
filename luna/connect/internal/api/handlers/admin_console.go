package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
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
	_ = h.DB.QueryRow(`SELECT COALESCE((SELECT SUM(size) FROM storage_packs), 0) + COALESCE((SELECT SUM(bytes) FROM storage_records), 0)`).Scan(&backupBytes)
	JSON(w, http.StatusOK, map[string]any{
		"accounts":         accounts,
		"devices":          devices,
		"tokens_issued":    devices,
		"tokens_unclaimed": unbound,
		"tokens_revoked":   revoked,
		"backup_bytes":     backupBytes,
		"estimated_month":  estimatedMonthlyRevenue(h.DB),
	})
}

// estimatedMonthlyRevenue is what the current month bills across all accounts.
// It must be summed per account, not computed from total stored bytes: the
// monthly minimum applies to each account separately, so two accounts storing
// 3 GB each bill $6.00, while one account storing 6 GB bills $3.00.
func estimatedMonthlyRevenue(db *database.DB) float64 {
	period := billing.PeriodKeyUTC(time.Now())
	rows, err := db.Query(`
SELECT COALESCE(s.sample_sum, 0), COALESCE(s.sample_count, 0),
       COALESCE(e.egress_bytes, 0),
       COALESCE((SELECT SUM(size) FROM storage_packs WHERE account_id = a.id), 0)
     + COALESCE((SELECT SUM(bytes) FROM storage_records WHERE account_id = a.id), 0)
FROM accounts a
LEFT JOIN (
  SELECT account_id, SUM(stored_bytes) AS sample_sum, COUNT(*) AS sample_count
  FROM billing_storage_samples WHERE period_ym = ?
  GROUP BY account_id
) s ON s.account_id = a.id
LEFT JOIN billing_period_egress e ON e.account_id = a.id AND e.period_ym = ?`, period, period)
	if err != nil {
		return 0
	}
	defer rows.Close()

	var totalMills int64
	for rows.Next() {
		var sum, count, egress, live int64
		if err := rows.Scan(&sum, &count, &egress, &live); err != nil {
			continue
		}
		avg := live
		if count > 0 {
			avg = billing.AverageStoredBytes(sum, count)
		}
		totalMills += billing.MonthMills(avg, egress)
	}
	return float64(totalMills) / float64(billing.MillsPerDollar)
}

func (h AdminConsoleHandler) Devices(w http.ResponseWriter, r *http.Request) {
	limit, offset := parseListPage(r)
	var total int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&total)
	totalPtr := total

	rows, err := h.DB.Query(`
SELECT d.id, COALESCE(d.name, ''), COALESCE(d.subdomain, ''), d.account_id, COALESCE(a.email, ''), d.created_at,
  COALESCE(d.code_hint, ''), d.kind, COALESCE(d.last_seen_at, 0), d.revoked
FROM devices d
LEFT JOIN accounts a ON a.id = d.account_id
ORDER BY d.created_at DESC
LIMIT ? OFFSET ?`, limit, offset)
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
	JSON(w, http.StatusOK, map[string]any{
		"devices":    list,
		"pagination": buildListPage(limit, offset, len(list), &totalPtr),
	})
}

func (h AdminConsoleHandler) Accounts(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit, offset := parseListPage(r)

	countQuery := `SELECT COUNT(*) FROM accounts a WHERE 1=1`
	query := `
SELECT a.id, a.email, a.has_card, a.billing_status, a.email_verified, a.created_at,
  (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id) AS device_count
FROM accounts a
WHERE 1=1`
	args := []any{}
	if q != "" {
		filter := ` AND (a.email LIKE ? OR a.id LIKE ? OR EXISTS (
			SELECT 1 FROM devices d WHERE d.account_id = a.id AND (d.subdomain LIKE ? OR d.id LIKE ? OR d.code_hint LIKE ?)
		))`
		like := "%" + q + "%"
		countQuery += filter
		query += filter
		args = append(args, like, like, like, like, like)
	}
	query += ` ORDER BY a.created_at DESC LIMIT ? OFFSET ?`

	var total int
	_ = h.DB.QueryRow(countQuery, args...).Scan(&total)
	totalPtr := total

	queryArgs := append(args, limit, offset)
	rows, err := h.DB.Query(query, queryArgs...)
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
	JSON(w, http.StatusOK, map[string]any{
		"accounts":   list,
		"pagination": buildListPage(limit, offset, len(list), &totalPtr),
	})
}
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

	credits, err := billing.GetCreditBalance(h.DB, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not load the credit balance for this account.")
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
		"credits":        credits,
	})
}

// AddAccountCredit puts money on a customer's balance — the remedy when we get
// a bill wrong. The reason is required and stored with the movement, along with
// the staff member who made it, so a balance can always be explained.
func (h AdminConsoleHandler) AddAccountCredit(w http.ResponseWriter, r *http.Request) {
	accountID := strings.TrimSpace(chi.URLParam(r, "accountID"))
	if accountID == "" {
		JSONError(w, http.StatusBadRequest, "Account id is required.")
		return
	}
	var req struct {
		AmountCents int    `json:"amount_cents"`
		Reason      string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "Could not read that credit.")
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if req.AmountCents <= 0 {
		JSONError(w, http.StatusBadRequest, "Enter an amount greater than zero.")
		return
	}
	if reason == "" {
		JSONError(w, http.StatusBadRequest, "Say why this credit is being added.")
		return
	}
	adminID := AdminIDFrom(r.Context())
	if err := billing.AddCredit(h.DB, accountID, req.AmountCents, reason, "", adminID); err != nil {
		switch {
		case errors.Is(err, billing.ErrNoSuchAccount):
			JSONError(w, http.StatusNotFound, "That customer account was not found.")
		case errors.Is(err, billing.ErrCreditReasonRequired):
			JSONError(w, http.StatusBadRequest, "Say why this credit is being added.")
		case errors.Is(err, billing.ErrCreditAmountInvalid):
			JSONError(w, http.StatusBadRequest, "Enter an amount greater than zero.")
		default:
			JSONError(w, http.StatusInternalServerError, "Could not add that credit.")
		}
		return
	}
	credits, err := billing.GetCreditBalance(h.DB, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Credit added, but the new balance could not be read.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "credits": credits})
}

func (h AdminConsoleHandler) listAccountDevices(accountID string) ([]map[string]any, error) {
	rows, err := h.DB.Query(`
SELECT d.id, COALESCE(d.name, ''), COALESCE(d.subdomain, ''), COALESCE(d.tunnel_id, ''), COALESCE(d.code_hint, ''), d.kind,
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
		var id, name, sub, tunnelID, hint, kind, orderRef string
		var lastSeen, created int64
		var revoked int
		if err := rows.Scan(&id, &name, &sub, &tunnelID, &hint, &kind, &lastSeen, &revoked, &created, &orderRef); err != nil {
			return nil, err
		}
		list = append(list, deviceListFields(id, name, sub, tunnelID, hint, kind, orderRef, lastSeen, created, revoked, zone, now))
	}
	return list, nil
}

// DeviceCodes lists permanent device tokens for support / print (replaces issued_tokens admin UI).
func (h AdminConsoleHandler) DeviceCodes(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	status := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	all := strings.EqualFold(r.URL.Query().Get("all"), "1") ||
		strings.EqualFold(r.URL.Query().Get("all"), "true")
	limit, offset := parseListPage(r)

	query := `
SELECT d.id, d.kind, CASE WHEN d.revoked != 0 THEN 'revoked' WHEN d.account_id IS NOT NULL AND d.account_id != '' THEN 'bound' ELSE 'unbound' END,
  COALESCE(d.code_hint, ''), d.account_id, COALESCE(a.email, ''), COALESCE(d.subdomain, ''), COALESCE(d.order_ref, ''), d.created_at,
  COALESCE(d.code_sealed, '')
FROM devices d
LEFT JOIN accounts a ON a.id = d.account_id
WHERE 1=1`
	countQuery := `SELECT COUNT(*) FROM devices d LEFT JOIN accounts a ON a.id = d.account_id WHERE 1=1`
	args := []any{}

	if status != "" && status != "all" {
		switch status {
		case "unbound":
			filter := ` AND d.revoked = 0 AND (d.account_id IS NULL OR d.account_id = '')`
			query += filter
			countQuery += filter
		case "bound":
			filter := ` AND d.revoked = 0 AND d.account_id IS NOT NULL AND d.account_id != ''`
			query += filter
			countQuery += filter
		case "revoked":
			filter := ` AND d.revoked != 0`
			query += filter
			countQuery += filter
		}
	}

	if q != "" {
		norm := security.NormalizeToken(q)
		like := "%" + q + "%"
		if norm != "" && len(norm) >= 8 {
			hash := security.HashToken(norm)
			filter := ` AND (d.code_hint LIKE ? OR d.order_ref LIKE ? OR a.email LIKE ? OR d.id LIKE ? OR d.subdomain LIKE ? OR d.code_hash = ?)`
			query += filter
			countQuery += filter
			args = append(args, like, like, like, like, like, hash)
		} else {
			filter := ` AND (d.code_hint LIKE ? OR d.order_ref LIKE ? OR a.email LIKE ? OR d.id LIKE ? OR d.subdomain LIKE ?)`
			query += filter
			countQuery += filter
			args = append(args, like, like, like, like, like)
		}
	}
	query += ` ORDER BY d.created_at DESC`
	var total int
	_ = h.DB.QueryRow(countQuery, args...).Scan(&total)
	totalPtr := total
	if !all {
		query += ` LIMIT ? OFFSET ?`
		args = append(args, limit, offset)
	}
	rows, err := h.DB.Query(query, args...)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list device tokens.")
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
			JSONError(w, http.StatusInternalServerError, "Could not list device tokens.")
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
			"id":                 id,
			"kind":               kind,
			"status":             status,
			"hint":               hint,
			"account_id":         acctID,
			"account_email":      email,
			"device_hostname":    hostname,
			"order_ref":          orderRef,
			"created_at":         created,
			"can_revoke":         status == "unbound",
			"can_reveal":         false,
			"device_code_prefix": "",
		}
		// The full device token never ships in a list response; reveal goes
		// through GET /admin/device-codes/{id}/reveal for a single row.
		if sealed != "" {
			if code, err := security.OpenString(sealed); err == nil && code != "" {
				item["can_reveal"] = true
				item["device_code_prefix"] = security.DeviceCodePrefix(code)
			}
		}
		list = append(list, item)
	}
	out := map[string]any{
		"tokens": list,
	}
	if all {
		out["limited"] = false
		out["limit"] = len(list)
	} else {
		out["limited"] = true
		out["limit"] = limit
		out["pagination"] = buildListPage(limit, offset, len(list), &totalPtr)
	}
	JSON(w, http.StatusOK, out)
}

// RevealDeviceCode opens the sealed device token for one row (support path).
// The list endpoint only ever returns the hint and the 8-char setup prefix.
func (h AdminConsoleHandler) RevealDeviceCode(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "codeID"))
	if id == "" {
		JSONError(w, http.StatusBadRequest, "Device token id is required.")
		return
	}
	var hint, sealed string
	err := h.DB.QueryRow(`SELECT COALESCE(code_hint,''), COALESCE(code_sealed,'') FROM devices WHERE id = ?`, id).
		Scan(&hint, &sealed)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "That device token was not found.")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not read the device token. Try again.")
		return
	}
	if sealed == "" {
		JSON(w, http.StatusOK, map[string]any{
			"code_hint": hint,
			"message":   "Only the short hint is stored for this token. The full token is on the quick-start card.",
		})
		return
	}
	code, err := security.OpenString(sealed)
	if err != nil || code == "" {
		JSONError(w, http.StatusInternalServerError, "Could not read the device token. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"code":               code,
		"code_hint":          hint,
		"device_code_prefix": security.DeviceCodePrefix(code),
	})
}

func (h AdminConsoleHandler) RevokeDeviceCode(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "codeID"))
	if id == "" {
		JSONError(w, http.StatusBadRequest, "Device token id is required.")
		return
	}
	var account sql.NullString
	var revoked int
	err := h.DB.QueryRow(`SELECT account_id, revoked FROM devices WHERE id = ?`, id).Scan(&account, &revoked)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "That device token was not found.")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not revoke that device token. Try again.")
		return
	}
	if revoked != 0 {
		JSONError(w, http.StatusConflict, "That device token is already revoked.")
		return
	}
	if account.Valid && account.String != "" {
		JSONError(w, http.StatusConflict, "Unbind this Luna from its account before revoking the device token.")
		return
	}
	_, err = h.DB.Exec(`UPDATE devices SET revoked = 1 WHERE id = ?`, id)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not revoke that device token. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "status": "revoked"})
}

// PurgeDeviceCode removes a device token and its live Connect state. Backups stay.
func (h AdminConsoleHandler) PurgeDeviceCode(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "codeID"))
	if id == "" {
		JSONError(w, http.StatusBadRequest, "Device token id is required.")
		return
	}
	if err := purgeDeviceToken(h.Deps, id); err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "That device token was not found.")
		return
	} else if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not purge that device token. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "purged": true})
}

// DeleteAccount removes a customer account and purges linked Lunas. Backups stay.
func (h AdminConsoleHandler) DeleteAccount(w http.ResponseWriter, r *http.Request) {
	accountID := strings.TrimSpace(chi.URLParam(r, "accountID"))
	if accountID == "" {
		JSONError(w, http.StatusBadRequest, "Account id is required.")
		return
	}
	if err := deleteCustomerAccount(h.Deps, accountID); err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "That customer account was not found.")
		return
	} else if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not delete that customer account. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "id": accountID, "deleted": true})
}
