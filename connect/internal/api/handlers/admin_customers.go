package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// ListCustomerAccounts returns all customer portal accounts for staff support.
func (h *AdminHandler) ListCustomerAccounts(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT ca.id, ca.email, COALESCE(ca.name, ''), ca.plan_id, ca.email_verified, ca.totp_enabled,
		        ca.is_active, ca.created_at,
		        (SELECT COUNT(*) FROM devices d WHERE d.account_id = ca.id) AS device_count,
		        (SELECT COUNT(*) FROM connect_keys ck WHERE ck.account_id = ca.id AND ck.status != 'revoked') AS key_count
		 FROM customer_accounts ca
		 ORDER BY ca.created_at DESC`)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list customer accounts")
		return
	}
	defer rows.Close()

	accounts := []map[string]any{}
	for rows.Next() {
		var a struct {
			ID            string
			Email         string
			Name          string
			PlanID        string
			EmailVerified bool
			TOTPEnabled   bool
			IsActive      bool
			CreatedAt     time.Time
			DeviceCount   int
			KeyCount      int
		}
		if err := rows.Scan(&a.ID, &a.Email, &a.Name, &a.PlanID, &a.EmailVerified, &a.TOTPEnabled,
			&a.IsActive, &a.CreatedAt, &a.DeviceCount, &a.KeyCount); err != nil {
			JSONError(w, http.StatusInternalServerError, "could not list customer accounts")
			return
		}
		accounts = append(accounts, map[string]any{
			"id":             a.ID,
			"email":          a.Email,
			"name":           a.Name,
			"plan_id":        a.PlanID,
			"plan_name":      catalog.PlanName(a.PlanID),
			"email_verified": a.EmailVerified,
			"has_2fa":        a.TOTPEnabled,
			"is_active":      a.IsActive,
			"created_at":     a.CreatedAt.Format(time.RFC3339),
			"device_count":   a.DeviceCount,
			"key_count":      a.KeyCount,
		})
	}

	JSON(w, http.StatusOK, map[string]any{"accounts": accounts})
}

// GetCustomerAccount returns one customer account with devices and Connect keys.
func (h *AdminHandler) GetCustomerAccount(w http.ResponseWriter, r *http.Request) {
	accountID := chi.URLParam(r, "accountID")
	if accountID == "" {
		JSONError(w, http.StatusBadRequest, "account id required")
		return
	}

	var (
		email, name, planID, username string
		emailVerified, totpEnabled    bool
		isActive                      bool
		createdAt                     time.Time
	)
	err := h.db.QueryRowContext(r.Context(),
		`SELECT email, COALESCE(name, ''), plan_id, COALESCE(username, ''), email_verified, totp_enabled, is_active, created_at
		 FROM customer_accounts WHERE id = $1`, accountID).
		Scan(&email, &name, &planID, &username, &emailVerified, &totpEnabled, &isActive, &createdAt)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "customer account not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not load customer account")
		return
	}

	devices, err := h.listAccountDevices(r, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not load devices for this account")
		return
	}
	keys, err := h.listAccountConnectKeys(r, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not load Connect keys for this account")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"id":             accountID,
		"email":          email,
		"name":           name,
		"username":       username,
		"plan_id":        planID,
		"plan_name":      catalog.PlanName(planID),
		"email_verified": emailVerified,
		"has_2fa":        totpEnabled,
		"is_active":      isActive,
		"created_at":     createdAt.Format(time.RFC3339),
		"devices":        devices,
		"connect_keys":   keys,
	})
}

func (h *AdminHandler) listAccountDevices(r *http.Request, accountID string) ([]map[string]any, error) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, plan_id, subdomain, activated_at, last_seen_at, is_active
		 FROM devices WHERE account_id = $1 ORDER BY activated_at DESC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	devices := []map[string]any{}
	for rows.Next() {
		var d struct {
			ID          string
			PlanID      string
			Subdomain   sql.NullString
			ActivatedAt time.Time
			LastSeenAt  sql.NullTime
			IsActive    bool
		}
		if err := rows.Scan(&d.ID, &d.PlanID, &d.Subdomain, &d.ActivatedAt, &d.LastSeenAt, &d.IsActive); err != nil {
			return nil, err
		}
		entry := map[string]any{
			"id":           d.ID,
			"plan_id":      d.PlanID,
			"plan_name":    catalog.PlanName(d.PlanID),
			"activated_at": d.ActivatedAt.Format(time.RFC3339),
			"last_seen_at": nullTime(d.LastSeenAt),
			"is_active":    d.IsActive,
		}
		if d.Subdomain.Valid && d.Subdomain.String != "" {
			entry["subdomain"] = d.Subdomain.String
		}
		devices = append(devices, entry)
	}
	return devices, nil
}

func (h *AdminHandler) listAccountConnectKeys(r *http.Request, accountID string) ([]map[string]any, error) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT lk.id, lk.key_prefix, lk.plan_id, lk.status, lk.created_at, lk.activated_at,
		        d.id, d.is_active, COALESCE(lk.subdomain, d.subdomain, '')
		 FROM connect_keys lk
		 LEFT JOIN devices d ON lk.device_id = d.id
		 WHERE lk.account_id = $1
		 ORDER BY lk.created_at DESC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanConnectKeyRows(rows)
}

// ListConnectKeys returns Connect keys across all customer accounts.
func (h *AdminHandler) ListConnectKeys(w http.ResponseWriter, r *http.Request) {
	all := strings.EqualFold(r.URL.Query().Get("all"), "1") ||
		strings.EqualFold(r.URL.Query().Get("all"), "true")
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))

	query := `
SELECT lk.id, lk.key_prefix, lk.plan_id, lk.status, lk.created_at, lk.activated_at,
       d.id, d.is_active, COALESCE(lk.subdomain, d.subdomain, ''),
       ca.id, ca.email
FROM connect_keys lk
JOIN customer_accounts ca ON lk.account_id = ca.id
LEFT JOIN devices d ON lk.device_id = d.id`
	args := []any{}
	if statusFilter != "" {
		query += ` WHERE lk.status = $1`
		args = append(args, statusFilter)
	}
	query += ` ORDER BY lk.created_at DESC`
	if !all {
		query += ` LIMIT 500`
	}

	rows, err := h.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list Connect keys")
		return
	}
	defer rows.Close()

	keys := []map[string]any{}
	for rows.Next() {
		var lk struct {
			ID           string
			KeyPrefix    string
			PlanID       string
			Status       string
			CreatedAt    time.Time
			ActivatedAt  sql.NullTime
			DeviceID     sql.NullString
			DeviceActive sql.NullBool
			Subdomain    string
			AccountID    string
			AccountEmail string
		}
		if err := rows.Scan(&lk.ID, &lk.KeyPrefix, &lk.PlanID, &lk.Status, &lk.CreatedAt, &lk.ActivatedAt,
			&lk.DeviceID, &lk.DeviceActive, &lk.Subdomain, &lk.AccountID, &lk.AccountEmail); err != nil {
			JSONError(w, http.StatusInternalServerError, "could not list Connect keys")
			return
		}
		entry := map[string]any{
			"id":            lk.ID,
			"key_prefix":    lk.KeyPrefix + "...",
			"plan_id":       lk.PlanID,
			"plan_name":     catalog.PlanName(lk.PlanID),
			"status":        lk.Status,
			"created_at":    lk.CreatedAt.Format(time.RFC3339),
			"account_id":    lk.AccountID,
			"account_email": lk.AccountEmail,
			"can_revoke":    lk.Status == "unused",
		}
		if lk.ActivatedAt.Valid {
			entry["activated_at"] = lk.ActivatedAt.Time.Format(time.RFC3339)
		}
		if lk.DeviceID.Valid {
			entry["device_id"] = lk.DeviceID.String
			entry["device_active"] = lk.DeviceActive.Bool
		}
		if lk.Subdomain != "" {
			entry["subdomain"] = lk.Subdomain
		}
		keys = append(keys, entry)
	}

	JSON(w, http.StatusOK, map[string]any{
		"connect_keys": keys,
		"limited":      !all,
		"limit":        500,
	})
}

func scanConnectKeyRows(rows *sql.Rows) ([]map[string]any, error) {
	keys := []map[string]any{}
	for rows.Next() {
		var lk struct {
			ID           string
			KeyPrefix    string
			PlanID       string
			Status       string
			CreatedAt    time.Time
			ActivatedAt  sql.NullTime
			DeviceID     sql.NullString
			DeviceActive sql.NullBool
			Subdomain    string
		}
		if err := rows.Scan(&lk.ID, &lk.KeyPrefix, &lk.PlanID, &lk.Status, &lk.CreatedAt, &lk.ActivatedAt,
			&lk.DeviceID, &lk.DeviceActive, &lk.Subdomain); err != nil {
			return nil, err
		}
		entry := map[string]any{
			"id":         lk.ID,
			"key_prefix": lk.KeyPrefix + "...",
			"plan_id":    lk.PlanID,
			"plan_name":  catalog.PlanName(lk.PlanID),
			"status":     lk.Status,
			"created_at": lk.CreatedAt.Format(time.RFC3339),
			"can_revoke": lk.Status == "unused",
		}
		if lk.ActivatedAt.Valid {
			entry["activated_at"] = lk.ActivatedAt.Time.Format(time.RFC3339)
		}
		if lk.DeviceID.Valid {
			entry["device_id"] = lk.DeviceID.String
			entry["device_active"] = lk.DeviceActive.Bool
		}
		if lk.Subdomain != "" {
			entry["subdomain"] = lk.Subdomain
		}
		keys = append(keys, entry)
	}
	return keys, nil
}

// AdminGenerateConnectKey creates a Connect key for a customer account (staff support).
// The full key is returned once. Replaces any existing key on the account.
func (h *AdminHandler) AdminGenerateConnectKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"account_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.AccountID) == "" {
		JSONError(w, http.StatusBadRequest, "account_id required")
		return
	}
	accountID := strings.TrimSpace(req.AccountID)

	var planID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT plan_id FROM customer_accounts WHERE id = $1 AND is_active = TRUE", accountID).Scan(&planID)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "customer account not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not look up customer account")
		return
	}
	if planID == "" {
		planID = "free"
	}

	var existingID, existingStatus string
	err = h.db.QueryRowContext(r.Context(),
		`SELECT id, status FROM connect_keys WHERE account_id = $1`, accountID).Scan(&existingID, &existingStatus)
	if err != nil && err != sql.ErrNoRows {
		JSONError(w, http.StatusInternalServerError, "could not look up existing Connect key")
		return
	}
	if existingID != "" {
		if existingStatus == "active" {
			var deviceID string
			_ = h.db.QueryRowContext(r.Context(),
				"SELECT id FROM devices WHERE connect_key_id = $1 AND is_active = TRUE", existingID).Scan(&deviceID)
			if deviceID != "" {
				_, _ = h.db.ExecContext(r.Context(), "UPDATE devices SET is_active = FALSE WHERE id = $1", deviceID)
				_, _ = h.db.ExecContext(r.Context(), "UPDATE subscriptions SET status = 'cancelled' WHERE device_id = $1", deviceID)
				_, _ = h.db.ExecContext(r.Context(),
					"UPDATE service_credentials SET is_active = FALSE, revoked_at = $1 WHERE device_id = $2",
					time.Now(), deviceID)
			}
		}
		_, _ = h.db.ExecContext(r.Context(), "DELETE FROM connect_keys WHERE id = $1", existingID)
	}

	key := security.GenerateConnectKey()
	keyHash := hashToken(key)
	keyPrefix := key[:8]
	connectKeyID := security.GenerateID("lic")
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO connect_keys (id, key_hash, key_prefix, account_id, plan_id, status)
		 VALUES ($1, $2, $3, $4, $5, 'unused')`,
		connectKeyID, keyHash, keyPrefix, accountID, planID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not generate Connect key")
		return
	}

	h.auditLog(r, "generate_connect_key", "customer_account", accountID, map[string]any{
		"key_id": connectKeyID,
	})

	JSON(w, http.StatusOK, map[string]any{
		"connect_key": key,
		"key_id":      connectKeyID,
		"account_id":  accountID,
		"plan_id":     planID,
		"plan_name":   catalog.PlanName(planID),
		"message":     "Give this Connect key to the customer. It is shown only once.",
	})
}

// AdminRevokeConnectKey revokes an unused Connect key.
func (h *AdminHandler) AdminRevokeConnectKey(w http.ResponseWriter, r *http.Request) {
	keyID := chi.URLParam(r, "keyID")
	if keyID == "" {
		JSONError(w, http.StatusBadRequest, "key id required")
		return
	}

	var status string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT status FROM connect_keys WHERE id = $1", keyID).Scan(&status)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "Connect key not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not look up Connect key")
		return
	}
	if status != "unused" {
		JSONError(w, http.StatusConflict, "Only unused Connect keys can be revoked from the admin console")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE connect_keys SET status = 'revoked' WHERE id = $1", keyID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not revoke Connect key")
		return
	}

	h.auditLog(r, "revoke_connect_key", "connect_key", keyID, nil)

	JSON(w, http.StatusOK, map[string]string{"message": "Connect key revoked"})
}
