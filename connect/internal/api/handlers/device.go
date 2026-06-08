package handlers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
)

// DeviceHandler handles device activation, status, and lifecycle.
type DeviceHandler struct {
	db *sql.DB
}

func NewDeviceHandler(db *sql.DB) *DeviceHandler {
	return &DeviceHandler{db: db}
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
	deviceID := generateID()

	// Determine plan from token prefix or default to free
	planID := "free"
	if len(req.Token) > 0 {
		switch req.Token[0] {
		case '1', 'o', 'O':
			planID = "one"
		case 'p', 'P':
			planID = "payg"
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
		generateID(), deviceID, planID, time.Now())

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
	var totalCost float64
	_ = h.db.QueryRowContext(r.Context(),
		"SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events WHERE device_id = ? AND timestamp >= date('now', 'start of month')",
		deviceID).Scan(&totalCost)

	JSON(w, http.StatusOK, map[string]any{
		"current_cycle_start": time.Now().AddDate(0, 0, -15).Format(time.RFC3339),
		"current_cycle_end":   time.Now().AddDate(0, 0, 15).Format(time.RFC3339),
		"total_cost_usd":      totalCost,
		"credit_cap_usd":      10.00,
		"remaining_usd":       10.00 - totalCost,
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

	return map[string]any{
		"connected": true,
		"plan": map[string]string{
			"id":   planID,
			"name": planName(planID),
		},
		"services":   services,
		"token_hint": tokenHint,
	}
}

func planName(id string) string {
	switch id {
	case "one":
		return "Connect One"
	case "payg":
		return "Connect PAYG"
	default:
		return "Connect Free"
	}
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func generateID() string {
	return fmt.Sprintf("dev_%d_%s", time.Now().Unix(), randomHex(8))
}

func randomHex(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(97 + (i % 26)) // simplistic; replace with crypto/rand in production
	}
	return hex.EncodeToString(b)[:n*2]
}
