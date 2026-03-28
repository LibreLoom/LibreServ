package handlers

import (
	"encoding/json"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
)

// NotifyHandler exposes notification configuration (minus secrets) for UI hydration.
type NotifyHandler struct{}

// NewNotifyHandler creates a handler for notification configuration endpoints.
func NewNotifyHandler() *NotifyHandler {
	return &NotifyHandler{}
}

// Get returns current notify settings (SMTP without password).
// GET /api/v1/notify/config
func (h *NotifyHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	if cfg == nil {
		JSONError(w, http.StatusInternalServerError, "config not loaded")
		return
	}
	// redacted smtp password
	smtp := cfg.SMTP
	smtp.Password = ""
	JSON(w, http.StatusOK, map[string]interface{}{
		"smtp":   smtp,
		"notify": cfg.Notify,
	})
}

// Update allows configuring SMTP/notify at runtime (not persisted to disk).
// PUT /api/v1/notify/config
func (h *NotifyHandler) Update(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	if cfg == nil {
		JSONError(w, http.StatusInternalServerError, "config not loaded")
		return
	}

	var req struct {
		SMTP     *config.SMTPConfig    `json:"smtp,omitempty"`
		Notify   *config.Notifications `json:"notify,omitempty"`
		Persist  bool                  `json:"persist,omitempty"`
		FilePath string                `json:"file_path,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.SMTP != nil {
		updated := *req.SMTP
		if updated.Password == "" {
			updated.Password = cfg.SMTP.Password
		}
		cfg.SMTP = updated
	}
	if req.Notify != nil {
		cfg.Notify = *req.Notify
	}

	if req.Persist {
		if err := config.SaveConfig(req.FilePath); err != nil {
			JSONError(w, http.StatusInternalServerError, "failed to persist config")
			return
		}
	}

	redacted := cfg.SMTP
	redacted.Password = ""
	JSON(w, http.StatusOK, map[string]interface{}{
		"message": "notify config updated",
		"smtp":    redacted,
		"notify":  cfg.Notify,
	})
}

// PreviewRequest contains template preview params.
type PreviewRequest struct {
	Template string            `json:"template"`
	Data     map[string]string `json:"data"`
}

// Preview renders a text template with sample data.
// POST /api/v1/notify/preview
func (h *NotifyHandler) Preview(w http.ResponseWriter, r *http.Request) {
	var req PreviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Template == "" {
		JSONError(w, http.StatusBadRequest, "template required")
		return
	}
	body, err := email.RenderTemplate(req.Template, req.Data)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "failed to render template")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"body": body})
}
