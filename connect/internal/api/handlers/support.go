package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// SupportHandler handles device-facing support case operations.
type SupportHandler struct {
	db *sql.DB
}

func NewSupportHandler(db *sql.DB) *SupportHandler {
	return &SupportHandler{db: db}
}

// CreateCase allows a device to open a support case.
func (h *SupportHandler) CreateCase(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Summary     string   `json:"summary"`
		SessionCode string   `json:"session_code,omitempty"`
		Contact     string   `json:"contact,omitempty"`
		Scopes      []string `json:"scopes,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request")
		return
	}

	deviceID := middleware.GetDeviceID(r.Context())
	caseID := security.GenerateID("case")
	scopesJSON := "[]"
	if len(req.Scopes) > 0 {
		b, _ := json.Marshal(req.Scopes)
		scopesJSON = string(b)
	}

	_, err := h.db.ExecContext(r.Context(),
		`INSERT INTO support_cases (id, device_id, summary, session_code, contact, status, scopes_json)
		 VALUES (?, ?, ?, ?, ?, 'open', ?)`,
		caseID, deviceID, req.Summary, req.SessionCode, req.Contact, scopesJSON)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create case")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"id":      caseID,
		"status":  "open",
		"summary": req.Summary,
	})
}

// ListCases returns all support cases for the authenticated device.
func (h *SupportHandler) ListCases(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetDeviceID(r.Context())
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, summary, status, session_code, contact, created_at, updated_at
		 FROM support_cases WHERE device_id = ? ORDER BY created_at DESC`, deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list cases")
		return
	}
	defer rows.Close()

	cases := []map[string]any{}
	for rows.Next() {
		var c struct {
			ID          string
			Summary     string
			Status      string
			SessionCode sql.NullString
			Contact     sql.NullString
			CreatedAt   time.Time
			UpdatedAt   time.Time
		}
		_ = rows.Scan(&c.ID, &c.Summary, &c.Status, &c.SessionCode, &c.Contact, &c.CreatedAt, &c.UpdatedAt)
		cases = append(cases, map[string]any{
			"id":           c.ID,
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

func nullString(s sql.NullString) string {
	if s.Valid {
		return s.String
	}
	return ""
}
