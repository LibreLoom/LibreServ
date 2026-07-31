package handlers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
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

// Activate registers a device using a Connect key.
// The Connect key is purchased on the customer portal and entered on the device.
func (h *DeviceHandler) Activate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ConnectKey string `json:"connect_key"`
		DeviceName string `json:"device_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ConnectKey == "" {
		JSONError(w, http.StatusBadRequest, "connect_key required")
		return
	}

	keyHash := hashToken(req.ConnectKey)

	// Look up the Connect key
	var connectKeyID, planID, status, accountID string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, account_id, plan_id, status FROM connect_keys WHERE key_hash = $1`,
		keyHash).Scan(&connectKeyID, &accountID, &planID, &status)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusUnauthorized, "invalid Connect key")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not validate Connect key")
		return
	}

	if status == "revoked" {
		JSONError(w, http.StatusForbidden, "this Connect key has been revoked")
		return
	}
	if status == "active" {
		// Already activated — return existing device info
		var deviceID string
		_ = h.db.QueryRowContext(r.Context(),
			"SELECT id FROM devices WHERE connect_key_id = $1", connectKeyID).Scan(&deviceID)
		if deviceID != "" {
			// Update last seen
			_, _ = h.db.ExecContext(r.Context(),
				"UPDATE devices SET last_seen_at = $1, is_active = TRUE WHERE id = $2", time.Now(), deviceID)
			status := h.buildStatus(r.Context(), deviceID, planID, req.ConnectKey[:8]+"...")
			JSON(w, http.StatusOK, status)
			return
		}
	}

	// Create device — one device per account (enforced by DB unique constraint)
	deviceID := security.GenerateID("dev")
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO devices (id, account_id, connect_key_id, plan_id, activated_at, last_seen_at, is_active)
		 VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
		deviceID, accountID, connectKeyID, planID, time.Now(), time.Now())
	if err != nil {
		JSONError(w, http.StatusConflict, "This account already has an activated device. Deactivate it first to activate a new one.")
		return
	}

	// Mark Connect key as active
	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE connect_keys SET status = 'active', device_id = $1, activated_at = $2 WHERE id = $3",
		deviceID, time.Now(), connectKeyID)

	// Create or update subscription
	_, _ = h.db.ExecContext(r.Context(),
		`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at)
		 VALUES ($1, $2, $3, 'active', $4)
		 ON CONFLICT(device_id) DO UPDATE SET plan_id = excluded.plan_id, status = 'active'`,
		security.GenerateID("sub"), deviceID, planID, time.Now())

	// Ensure credit account exists
	_ = h.billing.EnsureAccountCredits(deviceID)

	keyHint := req.ConnectKey
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
	// Revoke all service credentials so stale "connected" states do not persist.
	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE service_credentials SET is_active = FALSE, revoked_at = $1 WHERE device_id = $2",
		time.Now(), deviceID)
	// Revoke the Connect key so it cannot be reused to re-activate.
	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE connect_keys SET status = 'revoked' WHERE device_id = $1", deviceID)
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

	// Compute credit cap from the plan's monthly price.
	var creditCapUSD float64
	if plan := catalog.PlanByID(summary.PlanID); plan != nil {
		creditCapUSD = float64(plan.PriceMonthlyCents) / 100.0
	}
	remainingUSD := creditCapUSD - summary.TotalCostUSD
	if remainingUSD < 0 {
		remainingUSD = 0
	}

	JSON(w, http.StatusOK, map[string]any{
		"device_id":            summary.DeviceID,
		"plan_id":              summary.PlanID,
		"current_cycle_start":  summary.CycleStart,
		"current_cycle_end":    summary.CycleEnd,
		"total_cost_usd":       summary.TotalCostUSD,
		"credit_cap_usd":       creditCapUSD,
		"remaining_usd":        remainingUSD,
		"provider_cost_usd":    summary.ProviderCostUSD,
		"credits_used":         summary.CreditsUsed,
		"credit_balance_cents": balance,
		"by_service":           summary.ByService,
	})
}

func (h *DeviceHandler) buildStatus(ctx context.Context, deviceID, planID, keyHint string) map[string]any {
	rows, _ := h.db.QueryContext(ctx,
		"SELECT service_type, is_active, credentials_json FROM service_credentials WHERE device_id = $1 AND is_active = TRUE",
		deviceID)
	defer rows.Close()

	services := map[string]map[string]any{
		"smtp": {
			"state": "disabled",
			"label": "Email / SMTP",
		},
		"domain": {
			"state": "disabled",
			"label": "Domain & DNS",
		},
		"backup": {
			"state": "disabled",
			"label": "Cloud Backup Storage",
		},
		"tunnel": {
			"state": "disabled",
			"label": "Tunnel",
		},
		"ai": {
			"state": "disabled",
			"label": "AI Assistant",
		},
		"support": {
			"state": "disabled",
			"label": "Human Support",
		},
	}

	// Track domain credentials JSON so we can populate subdomain details later.
	var domainCredsJSON string

	for rows.Next() {
		var svc string
		var active bool
		var credsJSON string
		_ = rows.Scan(&svc, &active, &credsJSON)
		if active {
			if s, ok := services[svc]; ok {
				s["state"] = "connected"
			}
			if svc == "domain" {
				domainCredsJSON = credsJSON
			}
		}
	}

	// Populate domain service details: custom domain takes precedence, then subdomain.
	if services["domain"]["state"] == "connected" {
		details := h.buildDomainDetails(ctx, deviceID, domainCredsJSON)
		if details != nil {
			services["domain"]["details"] = details
		}
	}

	if !catalog.HasHumanSupport(planID) {
		services["support"]["state"] = "unavailable"
	}

	return map[string]any{
		"connected": true,
		"plan": map[string]any{
			"id":   planID,
			"name": catalog.PlanName(planID),
		},
		"services":         services,
		"connect_key_hint": keyHint,
	}
}

// buildDomainDetails populates the details map for the domain service.
// If the device has an active custom domain, returns custom domain metadata
// (name, status, expiry, auto_renew). Otherwise, reads the subdomain name
// from the service credentials JSON.
func (h *DeviceHandler) buildDomainDetails(ctx context.Context, deviceID, credsJSON string) map[string]string {
	// Check for an active or grace custom domain.
	var domain, status string
	var autoRenew bool
	var expiresAt sql.NullTime
	err := h.db.QueryRowContext(ctx,
		`SELECT domain, status, auto_renew, expires_at
		 FROM custom_domains WHERE device_id = $1 AND status IN ('active', 'grace')
		 ORDER BY purchased_at DESC LIMIT 1`,
		deviceID).Scan(&domain, &status, &autoRenew, &expiresAt)
	if err == nil && domain != "" {
		details := map[string]string{
			"type":       "custom",
			"domain":     domain,
			"status":     status,
			"auto_renew": strconv.FormatBool(autoRenew),
		}
		if expiresAt.Valid {
			details["expires_at"] = expiresAt.Time.Format(time.RFC3339)
		}
		return details
	}

	// No custom domain — extract subdomain from credentials JSON.
	if credsJSON == "" {
		return nil
	}
	var creds map[string]any
	if json.Unmarshal([]byte(credsJSON), &creds) != nil {
		return nil
	}
	if subdomain, ok := creds["domain"].(string); ok && subdomain != "" {
		return map[string]string{
			"type":   "subdomain",
			"domain": subdomain,
		}
	}
	return nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
