package handlers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// DeviceHandler handles device activation, status, and lifecycle.
type DeviceHandler struct {
	db      *sql.DB
	billing *billing.Service
}

func NewDeviceHandler(db *sql.DB) *DeviceHandler {
	return &DeviceHandler{db: db, billing: billing.NewService(db)}
}

// Activate registers a device using a license key.
// The license key is purchased on the customer portal and entered on the device.
func (h *DeviceHandler) Activate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		LicenseKey string `json:"license_key"`
		DeviceName string `json:"device_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.LicenseKey == "" {
		JSONError(w, http.StatusBadRequest, "license_key required")
		return
	}

	keyHash := hashToken(req.LicenseKey)

	// Look up the license key
	var licenseID, planID, status string
	var accountID sql.NullString
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, account_id, plan_id, status FROM license_keys WHERE key_hash = $1`,
		keyHash).Scan(&licenseID, &accountID, &planID, &status)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusUnauthorized, "invalid license key")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not validate license key")
		return
	}

	if status == "revoked" {
		JSONError(w, http.StatusForbidden, "this license key has been revoked")
		return
	}
	if status == "active" {
		// Already activated — return existing device info
		var deviceID string
		_ = h.db.QueryRowContext(r.Context(),
			"SELECT id FROM devices WHERE license_key_id = $1", licenseID).Scan(&deviceID)
		if deviceID != "" {
			// Update last seen
			_, _ = h.db.ExecContext(r.Context(),
				"UPDATE devices SET last_seen_at = $1, is_active = TRUE WHERE id = $2", time.Now(), deviceID)
			status := h.buildStatus(r.Context(), deviceID, planID, req.LicenseKey[:8]+"...")
			JSON(w, http.StatusOK, status)
			return
		}
	}

	// Create device
	deviceID := security.GenerateID("dev")
	var accountVal any
	if accountID.Valid {
		accountVal = accountID.String
	}
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO devices (id, account_id, license_key_id, plan_id, activated_at, last_seen_at, is_active)
		 VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
		deviceID, accountVal, licenseID, planID, time.Now(), time.Now())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not activate device")
		return
	}

	// Mark license key as active
	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE license_keys SET status = 'active', device_id = $1, activated_at = $2 WHERE id = $3",
		deviceID, time.Now(), licenseID)

	// Create or update subscription
	_, _ = h.db.ExecContext(r.Context(),
		`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at)
		 VALUES ($1, $2, $3, 'active', $4)
		 ON CONFLICT(device_id) DO UPDATE SET plan_id = excluded.plan_id, status = 'active'`,
		security.GenerateID("sub"), deviceID, planID, time.Now())

	// Ensure credit account exists
	_ = h.billing.EnsureAccountCredits(deviceID)

	keyHint := req.LicenseKey
	if len(keyHint) > 8 {
		keyHint = keyHint[:8] + "..."
	}

	statusResp := h.buildStatus(r.Context(), deviceID, planID, keyHint)
	JSON(w, http.StatusOK, statusResp)
}

func (h *DeviceHandler) Deactivate(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetDeviceID(r.Context())
	_, err := h.db.ExecContext(r.Context(),
		"UPDATE devices SET is_active = FALSE WHERE id = $1", deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not deactivate")
		return
	}
	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE subscriptions SET status = 'cancelled' WHERE device_id = $1", deviceID)
	JSON(w, http.StatusOK, map[string]string{"message": "deactivated"})
}

func (h *DeviceHandler) Status(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetDeviceID(r.Context())
	var planID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT plan_id FROM devices WHERE id = $1", deviceID).Scan(&planID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "device not found")
		return
	}

	status := h.buildStatus(r.Context(), deviceID, planID, "")
	JSON(w, http.StatusOK, status)
}

func (h *DeviceHandler) Usage(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetDeviceID(r.Context())
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

func (h *DeviceHandler) buildStatus(ctx context.Context, deviceID, planID, keyHint string) map[string]any {
	rows, _ := h.db.QueryContext(ctx,
		"SELECT service_type, is_active FROM service_credentials WHERE device_id = $1 AND is_active = TRUE",
		deviceID)
	defer rows.Close()

	services := map[string]map[string]string{
		"smtp":    {"state": "disabled", "label": "Email / SMTP"},
		"domain":  {"state": "disabled", "label": "Domain & DNS"},
		"backup":  {"state": "disabled", "label": "Cloud Backup Storage"},
		"tunnel":  {"state": "disabled", "label": "Tunnel"},
		"ai":      {"state": "disabled", "label": "AI Assistant"},
		"support": {"state": "disabled", "label": "Human Support"},
	}

	for rows.Next() {
		var svc string
		var active bool
		_ = rows.Scan(&svc, &active)
		if active {
			if s, ok := services[svc]; ok {
				s["state"] = "connected"
			}
		}
	}

	if !catalog.HasHumanSupport(planID) {
		services["support"]["state"] = "unavailable"
	}

	return map[string]any{
		"connected": true,
		"plan": map[string]string{
			"id":   planID,
			"name": catalog.PlanName(planID),
		},
		"services": services,
		"key_hint": keyHint,
	}
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
