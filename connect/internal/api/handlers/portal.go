package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// PortalHandler handles customer-facing self-service API.
type PortalHandler struct {
	db      *sql.DB
	billing *billing.Service
}

func NewPortalHandler(db *sql.DB) *PortalHandler {
	return &PortalHandler{db: db, billing: billing.NewService(db)}
}

// Register creates a new customer account.
func (h *PortalHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "email and password required")
		return
	}
	if len(req.Password) < 8 {
		JSONError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not hash password")
		return
	}

	accountID := security.GenerateID("acct")
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO customer_accounts (id, email, password_hash, name) VALUES (?, ?, ?, ?)`,
		accountID, req.Email, hash, req.Name)
	if err != nil {
		JSONError(w, http.StatusConflict, "an account with this email already exists")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"message": "account created. Please sign in.",
		"id":      accountID,
	})
}

// Login authenticates a customer with email/password (and TOTP if enabled).
func (h *PortalHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		TOTPCode string `json:"totp_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "email and password required")
		return
	}

	var account struct {
		ID           string
		PasswordHash string
		Name         sql.NullString
		TOTPSecret   sql.NullString
		TOTPEnabled  bool
		IsActive     bool
	}
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, password_hash, name, totp_secret, totp_enabled, is_active FROM customer_accounts WHERE email = ?`,
		req.Email).Scan(&account.ID, &account.PasswordHash, &account.Name, &account.TOTPSecret, &account.TOTPEnabled, &account.IsActive)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not authenticate")
		return
	}
	if !account.IsActive {
		JSONError(w, http.StatusForbidden, "account is disabled")
		return
	}

	if err := auth.VerifyPassword(account.PasswordHash, req.Password); err != nil {
		JSONError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	if account.TOTPEnabled && account.TOTPSecret.Valid {
		if req.TOTPCode == "" {
			JSON(w, http.StatusOK, map[string]any{
				"requires_2fa": true,
				"message":      "Enter your authenticator code to continue.",
			})
			return
		}
		if !auth.VerifyTOTP(account.TOTPSecret.String, req.TOTPCode) {
			JSONError(w, http.StatusUnauthorized, "invalid authenticator code")
			return
		}
	}

	token, err := middleware.CreateCustomerSession(h.db, account.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	name := ""
	if account.Name.Valid {
		name = account.Name.String
	}

	JSON(w, http.StatusOK, map[string]any{
		"token":   token,
		"id":      account.ID,
		"email":   req.Email,
		"name":    name,
		"has_2fa": account.TOTPEnabled,
	})
}

// Setup2FA generates a TOTP secret and returns the QR URI.
func (h *PortalHandler) Setup2FA(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not generate secret")
		return
	}

	var email string
	_ = h.db.QueryRowContext(r.Context(),
		"SELECT email FROM customer_accounts WHERE id = ?", accountID).Scan(&email)

	uri := auth.TOTPURI(secret, email, "LibreServ Connect")

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE customer_accounts SET totp_secret = ? WHERE id = ?", secret, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not save secret")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"secret": secret,
		"uri":    uri,
	})
}

// Verify2FA verifies a TOTP code and enables 2FA.
func (h *PortalHandler) Verify2FA(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
		JSONError(w, http.StatusBadRequest, "code required")
		return
	}

	var secret sql.NullString
	err := h.db.QueryRowContext(r.Context(),
		"SELECT totp_secret FROM customer_accounts WHERE id = ?", accountID).Scan(&secret)
	if err != nil || !secret.Valid {
		JSONError(w, http.StatusBadRequest, "set up 2FA first")
		return
	}

	if !auth.VerifyTOTP(secret.String, req.Code) {
		JSONError(w, http.StatusUnauthorized, "invalid code")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE customer_accounts SET totp_enabled = 1, updated_at = ? WHERE id = ?", time.Now(), accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not enable 2FA")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "2FA enabled"})
}

// Disable2FA turns off 2FA (requires current TOTP code).
func (h *PortalHandler) Disable2FA(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
		JSONError(w, http.StatusBadRequest, "code required")
		return
	}

	var secret sql.NullString
	err := h.db.QueryRowContext(r.Context(),
		"SELECT totp_secret FROM customer_accounts WHERE id = ?", accountID).Scan(&secret)
	if err != nil || !secret.Valid {
		JSONError(w, http.StatusBadRequest, "2FA not configured")
		return
	}

	if !auth.VerifyTOTP(secret.String, req.Code) {
		JSONError(w, http.StatusUnauthorized, "invalid code")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE customer_accounts SET totp_enabled = 0, totp_secret = NULL, updated_at = ? WHERE id = ?",
		time.Now(), accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not disable 2FA")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "2FA disabled"})
}

// GenerateLicenseKey creates a new license key for a plan. The customer enters
// this key on their LibreServ device to activate Connect services.
func (h *PortalHandler) GenerateLicenseKey(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var req struct {
		PlanID string `json:"plan_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PlanID == "" {
		JSONError(w, http.StatusBadRequest, "plan_id required")
		return
	}

	if catalog.PlanByID(req.PlanID) == nil {
		JSONError(w, http.StatusBadRequest, "invalid plan")
		return
	}

	// Generate a human-readable license key: XXXX-XXXX-XXXX-XXXX
	key := security.GenerateLicenseKey()
	keyHash := hashToken(key)
	keyPrefix := key[:8]

	licenseID := security.GenerateID("lic")
	_, err := h.db.ExecContext(r.Context(),
		`INSERT INTO license_keys (id, key_hash, key_prefix, account_id, plan_id, status)
		 VALUES (?, ?, ?, ?, ?, 'unused')`,
		licenseID, keyHash, keyPrefix, accountID, req.PlanID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not generate license key")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"license_key": key,
		"key_id":      licenseID,
		"plan_id":     req.PlanID,
		"plan_name":   catalog.PlanName(req.PlanID),
		"message":     "Enter this key on your LibreServ device in Settings → Connect to activate your subscription.",
	})
}

// GetLicenseKeys returns all license keys for the authenticated account.
func (h *PortalHandler) GetLicenseKeys(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT lk.id, lk.key_prefix, lk.plan_id, lk.status, lk.created_at, lk.activated_at,
		        d.id, d.is_active
		 FROM license_keys lk
		 LEFT JOIN devices d ON lk.device_id = d.id
		 WHERE lk.account_id = ?
		 ORDER BY lk.created_at DESC`, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve license keys")
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
		}
		_ = rows.Scan(&lk.ID, &lk.KeyPrefix, &lk.PlanID, &lk.Status, &lk.CreatedAt, &lk.ActivatedAt, &lk.DeviceID, &lk.DeviceActive)
		entry := map[string]any{
			"id":         lk.ID,
			"key_prefix": lk.KeyPrefix + "...",
			"plan_id":    lk.PlanID,
			"plan_name":  catalog.PlanName(lk.PlanID),
			"status":     lk.Status,
			"created_at": lk.CreatedAt.Format(time.RFC3339),
		}
		if lk.ActivatedAt.Valid {
			entry["activated_at"] = lk.ActivatedAt.Time.Format(time.RFC3339)
		}
		if lk.DeviceID.Valid {
			entry["device_id"] = lk.DeviceID.String
			entry["device_active"] = lk.DeviceActive.Bool
		}
		keys = append(keys, entry)
	}

	JSON(w, http.StatusOK, map[string]any{"license_keys": keys})
}

// RevokeLicenseKey revokes a license key.
func (h *PortalHandler) RevokeLicenseKey(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var req struct {
		KeyID string `json:"key_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.KeyID == "" {
		JSONError(w, http.StatusBadRequest, "key_id required")
		return
	}

	_, err := h.db.ExecContext(r.Context(),
		"UPDATE license_keys SET status = 'revoked' WHERE id = ? AND account_id = ? AND status != 'revoked'",
		req.KeyID, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not revoke license key")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "license key revoked"})
}

// GetDevices returns all devices linked to the authenticated account.
func (h *PortalHandler) GetDevices(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, plan_id, activated_at, last_seen_at, is_active FROM devices WHERE account_id = ? ORDER BY activated_at DESC`,
		accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not get devices")
		return
	}
	defer rows.Close()

	devices := []map[string]any{}
	for rows.Next() {
		var d struct {
			ID          string
			PlanID      string
			ActivatedAt time.Time
			LastSeenAt  sql.NullTime
			IsActive    bool
		}
		_ = rows.Scan(&d.ID, &d.PlanID, &d.ActivatedAt, &d.LastSeenAt, &d.IsActive)
		devices = append(devices, map[string]any{
			"id":           d.ID,
			"plan_id":      d.PlanID,
			"plan_name":    catalog.PlanName(d.PlanID),
			"activated_at": d.ActivatedAt.Format(time.RFC3339),
			"last_seen_at": nullTime(d.LastSeenAt),
			"is_active":    d.IsActive,
		})
	}

	JSON(w, http.StatusOK, map[string]any{"devices": devices})
}

// GetPlans returns the public plan catalog.
func (h *PortalHandler) GetPlans(w http.ResponseWriter, r *http.Request) {
	plans := catalog.Plans()
	result := make([]map[string]any, 0, len(plans))
	for _, p := range plans {
		result = append(result, map[string]any{
			"id":            p.ID,
			"name":          p.Name,
			"description":   p.Description,
			"price_monthly": p.PriceMonthlyCents,
			"limits":        p.Limits,
		})
	}
	JSON(w, http.StatusOK, map[string]any{"plans": result})
}

// GetUsage returns usage for the authenticated account's devices.
func (h *PortalHandler) GetUsage(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT id FROM devices WHERE account_id = ? AND is_active = 1 LIMIT 1", accountID).Scan(&deviceID)
	if err == sql.ErrNoRows {
		JSON(w, http.StatusOK, map[string]any{"message": "no devices linked to this account"})
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve usage")
		return
	}

	summary, err := h.billing.GetUsageSummary(deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve usage")
		return
	}

	balance, _ := h.billing.GetBalance(deviceID)

	JSON(w, http.StatusOK, map[string]any{
		"device_id":            summary.DeviceID,
		"plan_id":              summary.PlanID,
		"current_cycle_start":  summary.CycleStart,
		"current_cycle_end":    summary.CycleEnd,
		"total_cost_usd":       summary.TotalCostUSD,
		"provider_cost_usd":    summary.ProviderCostUSD,
		"credits_used":         summary.CreditsUsed,
		"credit_balance_cents": balance,
		"by_service":           summary.ByService,
	})
}

// GetBilling returns billing info for the authenticated account.
func (h *PortalHandler) GetBilling(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT id FROM devices WHERE account_id = ? AND is_active = 1 LIMIT 1", accountID).Scan(&deviceID)
	if err == sql.ErrNoRows {
		JSON(w, http.StatusOK, map[string]any{
			"credit_balance_cents": 0,
			"invoices":             []any{},
			"transactions":         []any{},
		})
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve billing")
		return
	}

	balance, _ := h.billing.GetBalance(deviceID)

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, stripe_invoice_id, status, amount_cents, period_start, period_end, created_at, paid_at
		 FROM invoices WHERE device_id = ? ORDER BY created_at DESC LIMIT 12`, deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve billing")
		return
	}
	defer rows.Close()

	invoices := []map[string]any{}
	for rows.Next() {
		var inv struct {
			ID              string
			StripeInvoiceID sql.NullString
			Status          string
			AmountCents     int
			PeriodStart     time.Time
			PeriodEnd       time.Time
			CreatedAt       time.Time
			PaidAt          sql.NullTime
		}
		_ = rows.Scan(&inv.ID, &inv.StripeInvoiceID, &inv.Status, &inv.AmountCents,
			&inv.PeriodStart, &inv.PeriodEnd, &inv.CreatedAt, &inv.PaidAt)
		invoices = append(invoices, map[string]any{
			"id":                inv.ID,
			"stripe_invoice_id": nullString(inv.StripeInvoiceID),
			"status":            inv.Status,
			"amount_cents":      inv.AmountCents,
			"period_start":      inv.PeriodStart.Format(time.RFC3339),
			"period_end":        inv.PeriodEnd.Format(time.RFC3339),
			"created_at":        inv.CreatedAt.Format(time.RFC3339),
			"paid_at":           nullTime(inv.PaidAt),
		})
	}

	txRows, err := h.db.QueryContext(r.Context(),
		`SELECT amount_cents, direction, reason, created_at FROM credit_transactions
		 WHERE device_id = ? ORDER BY created_at DESC LIMIT 20`, deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve transactions")
		return
	}
	defer txRows.Close()

	transactions := []map[string]any{}
	for txRows.Next() {
		var tx struct {
			AmountCents int
			Direction   string
			Reason      string
			CreatedAt   time.Time
		}
		_ = txRows.Scan(&tx.AmountCents, &tx.Direction, &tx.Reason, &tx.CreatedAt)
		transactions = append(transactions, map[string]any{
			"amount_cents": tx.AmountCents,
			"direction":    tx.Direction,
			"reason":       tx.Reason,
			"created_at":   tx.CreatedAt.Format(time.RFC3339),
		})
	}

	JSON(w, http.StatusOK, map[string]any{
		"credit_balance_cents": balance,
		"invoices":             invoices,
		"transactions":         transactions,
	})
}

// Subscribe creates a subscription for a device.
func (h *PortalHandler) Subscribe(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())
	var req struct {
		PlanID   string `json:"plan_id"`
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PlanID == "" {
		JSONError(w, http.StatusBadRequest, "plan_id required")
		return
	}

	if catalog.PlanByID(req.PlanID) == nil {
		JSONError(w, http.StatusBadRequest, "invalid plan")
		return
	}

	deviceID := req.DeviceID
	if deviceID == "" {
		err := h.db.QueryRowContext(r.Context(),
			"SELECT id FROM devices WHERE account_id = ? AND is_active = 1 LIMIT 1", accountID).Scan(&deviceID)
		if err != nil {
			JSONError(w, http.StatusBadRequest, "no device linked to your account")
			return
		}
	}

	_, err := h.db.ExecContext(r.Context(),
		`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at)
		 VALUES (?, ?, ?, 'active', ?)
		 ON CONFLICT(device_id) DO UPDATE SET plan_id = excluded.plan_id, status = 'active', started_at = excluded.started_at`,
		security.GenerateID("sub"), deviceID, req.PlanID, time.Now())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not subscribe")
		return
	}

	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE devices SET plan_id = ? WHERE id = ?", req.PlanID, deviceID)

	JSON(w, http.StatusOK, map[string]any{
		"message":   "subscription created",
		"plan_id":   req.PlanID,
		"plan_name": catalog.PlanName(req.PlanID),
	})
}

// Cancel cancels the device's subscription.
func (h *PortalHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT id FROM devices WHERE account_id = ? AND is_active = 1 LIMIT 1", accountID).Scan(&deviceID)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "no device linked to your account")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE subscriptions SET status = 'cancelled', ends_at = ? WHERE device_id = ? AND status = 'active'",
		time.Now().AddDate(0, 1, 0), deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not cancel subscription")
		return
	}

	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE devices SET plan_id = 'free' WHERE id = ?", deviceID)

	JSON(w, http.StatusOK, map[string]string{"message": "subscription cancelled"})
}

// ChangePlan changes the device's subscription plan.
func (h *PortalHandler) ChangePlan(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())
	var req struct {
		PlanID   string `json:"plan_id"`
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PlanID == "" {
		JSONError(w, http.StatusBadRequest, "plan_id required")
		return
	}

	if catalog.PlanByID(req.PlanID) == nil {
		JSONError(w, http.StatusBadRequest, "invalid plan")
		return
	}

	deviceID := req.DeviceID
	if deviceID == "" {
		err := h.db.QueryRowContext(r.Context(),
			"SELECT id FROM devices WHERE account_id = ? AND is_active = 1 LIMIT 1", accountID).Scan(&deviceID)
		if err != nil {
			JSONError(w, http.StatusBadRequest, "no device linked to your account")
			return
		}
	}

	_, err := h.db.ExecContext(r.Context(),
		`UPDATE subscriptions SET plan_id = ?, started_at = ? WHERE device_id = ? AND status = 'active'`,
		req.PlanID, time.Now(), deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not change plan")
		return
	}

	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE devices SET plan_id = ? WHERE id = ?", req.PlanID, deviceID)

	JSON(w, http.StatusOK, map[string]any{
		"message":   "plan changed",
		"plan_id":   req.PlanID,
		"plan_name": catalog.PlanName(req.PlanID),
	})
}

// RespondConsent allows a customer to approve or deny a consent request.
func (h *PortalHandler) RespondConsent(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	consentID := r.URL.Query().Get("id")
	if consentID == "" {
		// Try to extract from path
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) >= 3 {
			consentID = parts[2]
		}
	}
	if consentID == "" {
		JSONError(w, http.StatusBadRequest, "consent id required")
		return
	}

	var req struct {
		Decision string `json:"decision"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || (req.Decision != "granted" && req.Decision != "denied") {
		JSONError(w, http.StatusBadRequest, "decision must be 'granted' or 'denied'")
		return
	}

	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT cr.device_id FROM consent_requests cr
		 JOIN devices d ON cr.device_id = d.id
		 WHERE cr.id = ? AND d.account_id = ?`, consentID, accountID).Scan(&deviceID)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "consent request not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not verify consent request")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		`UPDATE consent_requests SET status = ?, responded_at = ? WHERE id = ? AND status = 'pending'`,
		req.Decision, time.Now(), consentID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not respond to consent request")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message": "consent " + req.Decision,
		"status":  req.Decision,
	})
}

// GetConsentRequests returns pending consent requests for the account's devices.
func (h *PortalHandler) GetConsentRequests(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT cr.id, cr.case_id, cr.path, cr.scope_type, cr.status, cr.requested_at, cr.expires_at, cr.notes
		 FROM consent_requests cr
		 JOIN devices d ON cr.device_id = d.id
		 WHERE d.account_id = ? AND cr.status = 'pending'
		 ORDER BY cr.requested_at DESC`, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve consent requests")
		return
	}
	defer rows.Close()

	requests := []map[string]any{}
	for rows.Next() {
		var cr struct {
			ID          string
			CaseID      string
			Path        string
			ScopeType   string
			Status      string
			RequestedAt time.Time
			ExpiresAt   sql.NullTime
			Notes       sql.NullString
		}
		_ = rows.Scan(&cr.ID, &cr.CaseID, &cr.Path, &cr.ScopeType, &cr.Status, &cr.RequestedAt, &cr.ExpiresAt, &cr.Notes)
		requests = append(requests, map[string]any{
			"id":           cr.ID,
			"case_id":      cr.CaseID,
			"path":         cr.Path,
			"scope_type":   cr.ScopeType,
			"status":       cr.Status,
			"requested_at": cr.RequestedAt.Format(time.RFC3339),
			"expires_at":   nullTime(cr.ExpiresAt),
			"notes":        nullString(cr.Notes),
		})
	}

	JSON(w, http.StatusOK, map[string]any{"consent_requests": requests})
}

// CreateCheckoutSession creates a Stripe Checkout session for subscribing to a plan.
func (h *PortalHandler) CreateCheckoutSession(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	bodyBytes, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	var req struct {
		PlanID   string `json:"plan_id"`
		DeviceID string `json:"device_id"`
	}
	if err := json.Unmarshal(bodyBytes, &req); err != nil || req.PlanID == "" {
		JSONError(w, http.StatusBadRequest, "plan_id required")
		return
	}

	plan := catalog.PlanByID(req.PlanID)
	if plan == nil {
		JSONError(w, http.StatusBadRequest, "invalid plan")
		return
	}

	if !catalog.IsPaidPlan(req.PlanID) {
		// Free plan — no checkout needed, just subscribe directly
		h.Subscribe(w, r)
		return
	}

	if !config.C.Stripe.Enabled {
		// Stripe not configured — subscribe directly (dev mode)
		h.Subscribe(w, r)
		return
	}

	// Get Stripe price ID for the plan
	var priceID string
	switch req.PlanID {
	case "lite":
		priceID = config.C.Stripe.PriceLite
	case "one":
		priceID = config.C.Stripe.PriceOne
	}
	if priceID == "" {
		JSONError(w, http.StatusInternalServerError, "stripe price not configured for this plan")
		return
	}

	// In production, create a real Stripe Checkout Session here:
	// session, err := stripeClient.CheckoutSessions.New(&stripe.CheckoutSessionParams{
	//     PaymentMethodTypes: []*string{stripe.String("card")},
	//     LineItems: []*stripe.CheckoutSessionLineItemParams{{
	//         Price:    stripe.String(priceID),
	//         Quantity: stripe.Int64(1),
	//     }},
	//     Mode:       stripe.String("subscription"),
	//     SuccessURL: stripe.String(config.C.Server.BaseURL + "/portal/billing?status=success"),
	//     CancelURL:  stripe.String(config.C.Server.BaseURL + "/portal/plans?status=cancelled"),
	//     ClientReferenceID: stripe.String(accountID),
	// })

	// For now, return a placeholder checkout URL
	JSON(w, http.StatusOK, map[string]any{
		"checkout_url": "#checkout-" + req.PlanID,
		"plan_id":      req.PlanID,
		"price_id":     priceID,
		"account_id":   accountID,
	})
}

// BillingPortal redirects to Stripe's billing portal for subscription management.
func (h *PortalHandler) BillingPortal(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	if !config.C.Stripe.Enabled {
		// Dev mode — redirect to our own billing page
		JSON(w, http.StatusOK, map[string]any{
			"portal_url": "/billing",
			"message":    "Stripe not enabled. Manage your subscription from the Billing page.",
		})
		return
	}

	// In production, create a Stripe Billing Portal session:
	// session, err := stripeClient.BillingPortalSessions.New(&stripe.BillingPortalSessionParams{
	//     Customer:  stripe.String(stripeCustomerID),
	//     ReturnURL: stripe.String(config.C.Server.BaseURL + "/portal/billing"),
	// })

	JSON(w, http.StatusOK, map[string]any{
		"portal_url": "#stripe-portal",
		"account_id": accountID,
	})
}
