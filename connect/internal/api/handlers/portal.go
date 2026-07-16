package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
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

// Login authenticates a device with its activation token and creates a customer session.
func (h *PortalHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		JSONError(w, http.StatusBadRequest, "token required")
		return
	}

	tokenHash := hashToken(req.Token)
	var deviceID, planID string
	var isActive bool
	err := h.db.QueryRowContext(r.Context(),
		"SELECT id, plan_id, is_active FROM devices WHERE token_hash = ?", tokenHash).
		Scan(&deviceID, &planID, &isActive)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusUnauthorized, "invalid token")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not authenticate")
		return
	}
	if !isActive {
		JSONError(w, http.StatusForbidden, "device is not active")
		return
	}

	sessionToken, err := middleware.CreateCustomerSession(h.db, deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"token":     sessionToken,
		"device_id": deviceID,
		"plan_id":   planID,
		"plan_name": catalog.PlanName(planID),
	})
}

// GetDevices returns the authenticated device's info.
func (h *PortalHandler) GetDevices(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetCustomerDeviceID(r.Context())
	var planID string
	var activatedAt time.Time
	var isActive bool
	err := h.db.QueryRowContext(r.Context(),
		"SELECT plan_id, activated_at, is_active FROM devices WHERE id = ?", deviceID).
		Scan(&planID, &activatedAt, &isActive)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not get device")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"device_id":     deviceID,
		"plan_id":       planID,
		"plan_name":     catalog.PlanName(planID),
		"activated_at":  activatedAt.Format(time.RFC3339),
		"is_active":     isActive,
	})
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

// GetUsage returns usage for the authenticated device.
func (h *PortalHandler) GetUsage(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetCustomerDeviceID(r.Context())
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
		"current_cycle_end":     summary.CycleEnd,
		"total_cost_usd":       summary.TotalCostUSD,
		"provider_cost_usd":    summary.ProviderCostUSD,
		"credits_used":         summary.CreditsUsed,
		"credit_balance_cents": balance,
		"by_service":           summary.ByService,
	})
}

// GetBilling returns billing info for the authenticated device.
func (h *PortalHandler) GetBilling(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetCustomerDeviceID(r.Context())

	balance, _ := h.billing.GetBalance(deviceID)

	// Get recent invoices
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

	// Get recent credit transactions
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
			Reason     string
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

// Subscribe creates a subscription for the device.
func (h *PortalHandler) Subscribe(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetCustomerDeviceID(r.Context())
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

	_, err := h.db.ExecContext(r.Context(),
		`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at)
		 VALUES (?, ?, ?, 'active', ?)
		 ON CONFLICT(device_id) DO UPDATE SET
		   plan_id = excluded.plan_id,
		   status = 'active',
		   started_at = excluded.started_at`,
		security.GenerateID("sub"), deviceID, req.PlanID, time.Now())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not subscribe")
		return
	}

	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE devices SET plan_id = ? WHERE id = ?", req.PlanID, deviceID)

	JSON(w, http.StatusOK, map[string]any{
		"message":  "subscription created",
		"plan_id":  req.PlanID,
		"plan_name": catalog.PlanName(req.PlanID),
	})
}

// Cancel cancels the device's subscription.
func (h *PortalHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetCustomerDeviceID(r.Context())

	_, err := h.db.ExecContext(r.Context(),
		"UPDATE subscriptions SET status = 'cancelled', ends_at = ? WHERE device_id = ? AND status = 'active'",
		time.Now().AddDate(0, 1, 0), deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not cancel subscription")
		return
	}

	// Downgrade to free at end of billing period
	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE devices SET plan_id = 'free' WHERE id = ?", deviceID)

	JSON(w, http.StatusOK, map[string]string{"message": "subscription cancelled"})
}

// ChangePlan changes the device's subscription plan.
func (h *PortalHandler) ChangePlan(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetCustomerDeviceID(r.Context())
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
