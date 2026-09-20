package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// AdminHandler handles staff/admin operations.
type AdminHandler struct {
	db      *sql.DB
	billing *billing.Service
}

func NewAdminHandler(db *sql.DB) *AdminHandler {
	return &AdminHandler{db: db, billing: billing.NewService(db)}
}

// ListDevices returns all registered devices.
func (h *AdminHandler) ListDevices(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, plan_id, activated_at, last_seen_at, is_active FROM devices ORDER BY activated_at DESC`)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list devices")
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
			"activated_at": d.ActivatedAt.Format(time.RFC3339),
			"last_seen_at": nullTime(d.LastSeenAt),
			"is_active":    d.IsActive,
		})
	}

	JSON(w, http.StatusOK, map[string]any{"devices": devices})
}

// GetDevice returns a single device.
func (h *AdminHandler) GetDevice(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "deviceID")
	var d struct {
		ID          string
		PlanID      string
		ActivatedAt time.Time
		LastSeenAt  sql.NullTime
		IsActive    bool
		Metadata    string
	}
	err := h.db.QueryRowContext(r.Context(),
		"SELECT id, plan_id, activated_at, last_seen_at, is_active, metadata_json FROM devices WHERE id = $1",
		deviceID).Scan(&d.ID, &d.PlanID, &d.ActivatedAt, &d.LastSeenAt, &d.IsActive, &d.Metadata)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "device not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not get device")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"id":           d.ID,
		"plan_id":      d.PlanID,
		"activated_at": d.ActivatedAt.Format(time.RFC3339),
		"last_seen_at": nullTime(d.LastSeenAt),
		"is_active":    d.IsActive,
		"metadata":     json.RawMessage(d.Metadata),
	})
}

// GetDeviceUsage returns usage summary for a device.
func (h *AdminHandler) GetDeviceUsage(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "deviceID")
	summary, err := h.billing.GetDeviceUsageForAdmin(deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve usage")
		return
	}
	JSON(w, http.StatusOK, summary)
}

// ListTunnels returns all provisioned tunnels for devices.
func (h *AdminHandler) ListTunnels(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT sc.id, sc.device_id, sc.credentials_json, sc.is_active, sc.provisioned_at, d.id as device_name
		 FROM service_credentials sc
		 LEFT JOIN devices d ON sc.device_id = d.id
		 WHERE sc.service_type = 'tunnel'
		 ORDER BY sc.provisioned_at DESC`)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list tunnels")
		return
	}
	defer rows.Close()

	tunnels := []map[string]any{}
	for rows.Next() {
		var d struct {
			ID          string
			DeviceID    string
			CredJSON    string
			IsActive    bool
			Provisioned time.Time
			DeviceName  sql.NullString
		}
		_ = rows.Scan(&d.ID, &d.DeviceID, &d.CredJSON, &d.IsActive, &d.Provisioned, &d.DeviceName)

		var tunnelName string
		if d.CredJSON != "" {
			var creds map[string]any
			if json.Unmarshal([]byte(d.CredJSON), &creds) == nil {
				if name, ok := creds["name"].(string); ok && name != "" {
					tunnelName = name
				} else if hostname, ok := creds["hostname"].(string); ok && hostname != "" {
					tunnelName = hostname
				}
			}
		}

		tunnels = append(tunnels, map[string]any{
			"id":             d.ID,
			"device_id":      d.DeviceID,
			"tunnel_name":    tunnelName,
			"is_active":      d.IsActive,
			"provisioned_at": d.Provisioned.Format(time.RFC3339),
			"device_name":    d.DeviceName.String,
		})
	}

	JSON(w, http.StatusOK, map[string]any{"tunnels": tunnels})
}

// RotateCredentials forces re-provisioning of credentials for a specific service on a device.
func (h *AdminHandler) RotateCredentials(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "deviceID")
	var req struct {
		Service string `json:"service"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "service required")
		return
	}

	_, err := h.db.ExecContext(r.Context(),
		"UPDATE service_credentials SET is_active = FALSE, revoked_at = $1 WHERE device_id = $2 AND service_type = $3",
		time.Now(), deviceID, req.Service)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not revoke credentials")
		return
	}

	h.auditLog(r, "rotate_credentials", "device", deviceID, map[string]any{"service": req.Service})

	JSON(w, http.StatusOK, map[string]string{
		"message": fmt.Sprintf("Credentials for %s revoked. Device must re-provision.", req.Service),
	})
}

// ListCases returns all support cases (admin view).
func (h *AdminHandler) ListCases(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, device_id, summary, status, session_code, contact, created_at, updated_at
		 FROM support_cases ORDER BY created_at DESC`)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list cases")
		return
	}
	defer rows.Close()

	cases := []map[string]any{}
	for rows.Next() {
		var c struct {
			ID          string
			DeviceID    string
			Summary     string
			Status      string
			SessionCode sql.NullString
			Contact     sql.NullString
			CreatedAt   time.Time
			UpdatedAt   time.Time
		}
		_ = rows.Scan(&c.ID, &c.DeviceID, &c.Summary, &c.Status, &c.SessionCode, &c.Contact, &c.CreatedAt, &c.UpdatedAt)
		cases = append(cases, map[string]any{
			"id":           c.ID,
			"device_id":    c.DeviceID,
			"summary":      c.Summary,
			"status":       c.Status,
			"session_code": nullString(c.SessionCode),
			"contact":      nullString(c.Contact),
			"created_at":   c.CreatedAt.Format(time.RFC3339),
			"updated_at":   c.UpdatedAt.Format(time.RFC3339),
		})
	}
	JSON(w, http.StatusOK, map[string]any{"cases": cases})
}

// GetCase returns a single case with messages.
func (h *AdminHandler) GetCase(w http.ResponseWriter, r *http.Request) {
	caseID := chi.URLParam(r, "caseID")
	var c struct {
		ID          string
		DeviceID    string
		Summary     string
		Status      string
		SessionCode sql.NullString
		Contact     sql.NullString
		ScopesJSON  string
		CreatedAt   time.Time
		UpdatedAt   time.Time
	}
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, device_id, summary, status, session_code, contact, scopes_json, created_at, updated_at
		 FROM support_cases WHERE id = $1`, caseID).Scan(&c.ID, &c.DeviceID, &c.Summary, &c.Status, &c.SessionCode, &c.Contact, &c.ScopesJSON, &c.CreatedAt, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "case not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not get case")
		return
	}

	// Fetch messages
	mrows, _ := h.db.QueryContext(r.Context(),
		`SELECT author, text, timestamp FROM case_messages WHERE case_id = $1 ORDER BY timestamp ASC`, caseID)
	defer mrows.Close()
	messages := []map[string]any{}
	for mrows.Next() {
		var author, text string
		var ts time.Time
		_ = mrows.Scan(&author, &text, &ts)
		messages = append(messages, map[string]any{
			"author":    author,
			"text":      text,
			"timestamp": ts.Format(time.RFC3339),
		})
	}

	JSON(w, http.StatusOK, map[string]any{
		"id":           c.ID,
		"device_id":    c.DeviceID,
		"summary":      c.Summary,
		"status":       c.Status,
		"session_code": nullString(c.SessionCode),
		"contact":      nullString(c.Contact),
		"scopes":       json.RawMessage(c.ScopesJSON),
		"messages":     messages,
		"created_at":   c.CreatedAt.Format(time.RFC3339),
		"updated_at":   c.UpdatedAt.Format(time.RFC3339),
	})
}

// AddCaseMessage allows staff to append a message to a case.
func (h *AdminHandler) AddCaseMessage(w http.ResponseWriter, r *http.Request) {
	caseID := chi.URLParam(r, "caseID")
	var req struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Text == "" {
		JSONError(w, http.StatusBadRequest, "text required")
		return
	}

	_, err := h.db.ExecContext(r.Context(),
		`INSERT INTO case_messages (case_id, author, text, timestamp) VALUES ($1, $2, $3, $4)`,
		caseID, "agent", req.Text, time.Now())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not add message")
		return
	}

	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE support_cases SET updated_at = $1 WHERE id = $2", time.Now(), caseID)

	h.auditLog(r, "add_case_message", "case", caseID, map[string]any{"text_length": len(req.Text)})

	JSON(w, http.StatusOK, map[string]string{"message": "message added"})
}

// CreateConsentRequest initiates a per-file/directory consent request.
func (h *AdminHandler) CreateConsentRequest(w http.ResponseWriter, r *http.Request) {
	caseID := chi.URLParam(r, "caseID")
	var req struct {
		Path      string `json:"path"`
		ScopeType string `json:"scope_type"` // file | directory | credential
		Notes     string `json:"notes,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" || req.ScopeType == "" {
		JSONError(w, http.StatusBadRequest, "path and scope_type required")
		return
	}

	// Look up device_id from case
	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT device_id FROM support_cases WHERE id = $1", caseID).Scan(&deviceID)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "case not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not find case")
		return
	}

	consentID := security.GenerateID("consent")
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO consent_requests (id, case_id, device_id, requested_by, path, scope_type, status, requested_at, expires_at, notes)
		 VALUES ($1, $2, $3, 'admin', $4, $5, 'pending', $6, NOW() + INTERVAL '24 hours', $7)`,
		consentID, caseID, deviceID, req.Path, req.ScopeType, time.Now(), req.Notes)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create consent request")
		return
	}

	h.auditLog(r, "create_consent_request", "case", caseID, map[string]any{
		"path": req.Path, "scope_type": req.ScopeType, "consent_id": consentID,
	})

	JSON(w, http.StatusOK, map[string]any{
		"id":      consentID,
		"status":  "pending",
		"path":    req.Path,
		"expires": time.Now().Add(24 * time.Hour).Format(time.RFC3339),
	})
}

// ListPlans returns all plan definitions.
func (h *AdminHandler) ListPlans(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.QueryContext(r.Context(),
		"SELECT id, name, description, price_monthly_cents, limits_json FROM plans")
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list plans")
		return
	}
	defer rows.Close()

	plans := []map[string]any{}
	for rows.Next() {
		var p struct {
			ID                string
			Name              string
			Description       string
			PriceMonthlyCents int
			LimitsJSON        string
		}
		_ = rows.Scan(&p.ID, &p.Name, &p.Description, &p.PriceMonthlyCents, &p.LimitsJSON)
		plans = append(plans, map[string]any{
			"id":            p.ID,
			"name":          p.Name,
			"description":   p.Description,
			"price_monthly": p.PriceMonthlyCents,
			"limits":        json.RawMessage(p.LimitsJSON),
		})
	}
	JSON(w, http.StatusOK, map[string]any{"plans": plans})
}

// UpdatePlan allows staff to modify plan definitions.
func (h *AdminHandler) UpdatePlan(w http.ResponseWriter, r *http.Request) {
	planID := chi.URLParam(r, "planID")
	var req struct {
		Name              string `json:"name"`
		Description       string `json:"description"`
		PriceMonthlyCents int    `json:"price_monthly"`
		LimitsJSON        string `json:"limits_json"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request")
		return
	}

	_, err := h.db.ExecContext(r.Context(),
		`UPDATE plans SET name = $1, description = $2, price_monthly_cents = $3, limits_json = $4 WHERE id = $5`,
		req.Name, req.Description, req.PriceMonthlyCents, req.LimitsJSON, planID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not update plan")
		return
	}

	h.auditLog(r, "update_plan", "plan", planID, map[string]any{
		"name": req.Name, "price": req.PriceMonthlyCents,
	})

	JSON(w, http.StatusOK, map[string]string{"message": "plan updated"})
}

// GetAggregatedUsage returns total usage across all devices.
func (h *AdminHandler) GetAggregatedUsage(w http.ResponseWriter, r *http.Request) {
	usage, err := h.billing.GetAggregatedUsage()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve usage")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"usage": usage})
}

// auditLog records a staff action in the audit log.
func (h *AdminHandler) auditLog(r *http.Request, action, targetType, targetID string, details map[string]any) {
	detailsJSON := "{}"
	if b, err := json.Marshal(details); err == nil {
		detailsJSON = string(b)
	}
	_, _ = h.db.ExecContext(r.Context(),
		`INSERT INTO audit_logs (actor, action, target_type, target_id, details_json) VALUES ($1, $2, $3, $4, $5)`,
		"admin", action, targetType, targetID, detailsJSON)
}

func nullTime(t sql.NullTime) string {
	if t.Valid {
		return t.Time.Format(time.RFC3339)
	}
	return ""
}
