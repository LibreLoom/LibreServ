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

func (h *DeviceHandler) Activate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		JSONError(w, http.StatusBadRequest, "token required")
		return
	}

	tokenHash := hashToken(req.Token)
	deviceID := security.GenerateID("dev")

	// Determine plan from token prefix or default to free
	planID := "free"
	if len(req.Token) > 0 {
		switch req.Token[0] {
		case '1', 'o', 'O':
			planID = "one"
		case 'l', 'L':
			planID = "lite"
		}
	}

	// Upsert device
	_, err := h.db.ExecContext(r.Context(),
		`INSERT INTO devices (id, token_hash, plan_id, activated_at, last_seen_at, is_active)
		 VALUES (?, ?, ?, ?, ?, 1)
		 ON CONFLICT(token_hash) DO UPDATE SET
		   last_seen_at = excluded.last_seen_at,
		   is_active = 1`,
		deviceID, tokenHash, planID, time.Now(), time.Now())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not activate device")
		return
	}

	// Create or update subscription
	_, _ = h.db.ExecContext(r.Context(),
		`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at)
		 VALUES (?, ?, ?, 'active', ?)
		 ON CONFLICT(device_id) DO UPDATE SET
		   plan_id = excluded.plan_id,
		   status = 'active'`,
		security.GenerateID("sub"), deviceID, planID, time.Now())

	// Ensure credit account exists
	_ = h.billing.EnsureAccountCredits(deviceID)

	status := h.buildStatus(r.Context(), deviceID, planID, req.Token)
	JSON(w, http.StatusOK, status)
}

func (h *DeviceHandler) Deactivate(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetDeviceID(r.Context())
	_, err := h.db.ExecContext(r.Context(),
		"UPDATE devices SET is_active = 0 WHERE id = ?", deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not deactivate")
		return
	}
	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE subscriptions SET status = 'cancelled' WHERE device_id = ?", deviceID)
	JSON(w, http.StatusOK, map[string]string{"message": "deactivated"})
}

func (h *DeviceHandler) Status(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetDeviceID(r.Context())
	var planID, tokenHash string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT plan_id, token_hash FROM devices WHERE id = ?", deviceID).Scan(&planID, &tokenHash)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "device not found")
		return
	}

	status := h.buildStatus(r.Context(), deviceID, planID, tokenHash)
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
		"device_id":        summary.DeviceID,
		"plan_id":          summary.PlanID,
		"current_cycle_start": summary.CycleStart,
		"current_cycle_end":   summary.CycleEnd,
		"total_cost_usd":      summary.TotalCostUSD,
		"provider_cost_usd":   summary.ProviderCostUSD,
		"credits_used":        summary.CreditsUsed,
		"credit_balance_cents": balance,
		"by_service":          summary.ByService,
	})
}

func (h *DeviceHandler) buildStatus(ctx context.Context, deviceID, planID, token string) map[string]any {
	tokenHint := ""
	if len(token) > 4 {
		tokenHint = token[:4] + "..."
	}

	rows, _ := h.db.QueryContext(ctx,
		"SELECT service_type, is_active FROM service_credentials WHERE device_id = ? AND is_active = 1",
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

	// Human support availability depends on plan
	if !catalog.HasHumanSupport(planID) {
		services["support"]["state"] = "unavailable"
	}

	return map[string]any{
		"connected": true,
		"plan": map[string]string{
			"id":   planID,
			"name": catalog.PlanName(planID),
		},
		"services":   services,
		"token_hint": tokenHint,
	}
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
