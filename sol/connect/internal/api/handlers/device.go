package handlers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/services"
)

// DeviceHandler handles device activation, status, and lifecycle.
type DeviceHandler struct {
	db           *sql.DB
	billing      *billing.Service
	provisioning *services.ProvisioningService
}

func NewDeviceHandler(db *sql.DB) *DeviceHandler {
	return &DeviceHandler{db: db, billing: billing.NewService(db), provisioning: services.NewProvisioningService(db)}
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

	// Look up the Connect key. The key can carry the subdomain the user picked
	// during onboarding (stamped by GenerateConnectKey), which becomes the
	// device's free plan subdomain — otherwise the device gets a random
	// device-ID suffix.
	var connectKeyID, planID, status, accountID string
	var stampedSub sql.NullString
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, account_id, plan_id, status, subdomain FROM connect_keys WHERE key_hash = $1`,
		keyHash).Scan(&connectKeyID, &accountID, &planID, &status, &stampedSub)
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
			keyHint := req.ConnectKey
			if len(keyHint) > 8 {
				keyHint = keyHint[:8] + "..."
			}
			status := h.buildStatus(r.Context(), deviceID, planID, keyHint)
			JSON(w, http.StatusOK, status)
			return
		}
	}

	// Reuse the account's prior (inactive) device row when one exists instead
	// of deleting it and inserting a fresh row. Deleting the row would
	// cascade-delete everything keyed by device_id — usage history, billing
	// cycles, invoices, support cases — and, critically, the prepaid credit
	// balance and the account's custom-domain links. Re-activating a device
	// after a key regeneration must never reset usage or billing.
	var priorDeviceID string
	err = h.db.QueryRowContext(r.Context(),
		"SELECT id FROM devices WHERE account_id = $1 AND is_active = FALSE LIMIT 1", accountID,
	).Scan(&priorDeviceID)
	if err != nil && err != sql.ErrNoRows {
		JSONError(w, http.StatusInternalServerError, "could not look up your existing device")
		return
	}
	deviceID := priorDeviceID
	if deviceID == "" {
		deviceID = security.GenerateID("dev")
	}

	// Check the stamped subdomain is still available — another device may have
	// claimed it since the key was generated. The device's own row (the one
	// being reused or freshly created) never counts against it.
	sub := ""
	if stampedSub.Valid && stampedSub.String != "" {
		sub = normalizeSubdomain(stampedSub.String)
		if sub == "" {
			JSONError(w, http.StatusBadRequest, "The Connect key carries an invalid subdomain. Regenerate it from your Connect dashboard.")
			return
		}
		var taken string
		if err := h.db.QueryRowContext(r.Context(),
			"SELECT id FROM devices WHERE subdomain = $1 AND id <> $2", sub, deviceID).Scan(&taken); err == nil && taken != "" {
			JSONError(w, http.StatusConflict, "That subdomain is already taken. Pick another in your Connect dashboard and try again.")
			return
		}
	}

	// If the regenerated key carries no stamp but the reused device had a
	// user-chosen subdomain, keep it instead of erasing it to NULL.
	if sub == "" && priorDeviceID != "" {
		var priorSub sql.NullString
		if err := h.db.QueryRow(`SELECT subdomain FROM devices WHERE id = $1`, deviceID).Scan(&priorSub); err == nil {
			sub = priorSub.String
		}
	}

	// Create or re-activate the device — one active device per account
	// (enforced by DB unique constraint).
	if priorDeviceID != "" {
		_, err = h.db.ExecContext(r.Context(),
			`UPDATE devices SET connect_key_id = $1, plan_id = $2, subdomain = $3,
			        activated_at = $4, last_seen_at = $5, is_active = TRUE
			 WHERE id = $6`,
			connectKeyID, planID, sql.NullString{String: sub, Valid: sub != ""}, time.Now(), time.Now(), deviceID)
	} else {
		_, err = h.db.ExecContext(r.Context(),
			`INSERT INTO devices (id, account_id, connect_key_id, plan_id, subdomain, activated_at, last_seen_at, is_active)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
			deviceID, accountID, connectKeyID, planID, sql.NullString{String: sub, Valid: sub != ""}, time.Now(), time.Now())
	}
	if err != nil {
		JSONError(w, http.StatusConflict, "This account already has an activated device. Deactivate it first to activate a new one.")
		return
	}

	// Mark Connect key as active
	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE connect_keys SET status = 'active', device_id = $1, activated_at = $2 WHERE id = $3",
		deviceID, time.Now(), connectKeyID)
	// Accept the stamped subdomain as the canonical one (updates are external:
	// SetSubdomain in the portal picks the final value).
	if sub != "" {
		_, _ = h.db.ExecContext(r.Context(),
			"UPDATE devices SET subdomain = $1 WHERE id = $2", sub, deviceID)
	}

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
	// Surface the assigned subdomain so the device can show it immediately
	// without waiting for a domain provision round-trip.
	if sub != "" {
		statusResp["subdomain"] = sub
	}
	JSON(w, http.StatusOK, statusResp)

	// Claim any unassigned custom domain on the account and reconcile the
	// device's domain state (custom domain → tunnel/DNS/credentials, or
	// fall back to the subdomain). Best-effort; the scheduler re-runs it.
	coord := services.NewDomainCoordinator(h.db)
	if err := coord.Activation(deviceID); err != nil {
		slog.Warn("activate: domain reconcile failed", "error", err, "device", deviceID)
	}
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
	// Delete the device's Cloudflare tunnel before revoking credentials so the
	// named tunnel does not leak in Cloudflare after deactivation.
	if h.provisioning != nil {
		_ = h.provisioning.Revoke(deviceID, "tunnel")
	}
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
	} else {
		// Human support is always available on plans that include it — it
		// doesn't need provisioning like the other services.
		services["support"]["state"] = "connected"
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
// The single source of truth is the coordinator: an active custom domain is
// serving; anything else (grace, cancelled, none) means the device serves
// its plan subdomain.
func (h *DeviceHandler) buildDomainDetails(ctx context.Context, deviceID, credsJSON string) map[string]string {
	// Check for the serving custom domain (status 'active' only — grace and
	// cancelled have been switched away from).
	var domain, status string
	var autoRenew bool
	var expiresAt sql.NullTime
	err := h.db.QueryRowContext(ctx,
		`SELECT domain, status, auto_renew, expires_at
		 FROM custom_domains WHERE device_id = $1 AND status = 'active'
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

	// No custom domain — extract subdomain from credentials JSON. The
	// credentials are stored as {"domain": {"domain": "<sub>.zone", ...}}.
	if credsJSON == "" {
		return nil
	}
	var creds map[string]any
	if json.Unmarshal([]byte(credsJSON), &creds) != nil {
		return nil
	}
	if svc, ok := creds["domain"].(map[string]any); ok {
		if subdomain, ok := svc["domain"].(string); ok && subdomain != "" {
			return map[string]string{
				"type":   "subdomain",
				"domain": subdomain,
			}
		}
	}
	return nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
