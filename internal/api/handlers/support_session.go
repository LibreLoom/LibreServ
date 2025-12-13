package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

// SupportSessionValidationHandler validates session code+token and returns session info plus allowed paths.
type SupportSessionValidationHandler struct {
	svc *support.Service
}

func NewSupportSessionValidationHandler(svc *support.Service) *SupportSessionValidationHandler {
	return &SupportSessionValidationHandler{svc: svc}
}

type validateReq struct {
	Code  string `json:"code"`
	Token string `json:"token"`
}

func (h *SupportSessionValidationHandler) Validate(w http.ResponseWriter, r *http.Request) {
	var req validateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Code == "" || req.Token == "" {
		JSONError(w, http.StatusBadRequest, "code and token required")
		return
	}

	sess, err := h.svc.ValidateCode(r.Context(), req.Code, req.Token)
	if err != nil {
		h.svc.LogAudit(r.Context(), &support.AuditEntry{
			SessionID:  req.Code,
			Actor:      "support-session",
			Action:     "validate",
			Target:     "session",
			Success:    false,
			Message:    err.Error(),
			OccurredAt: time.Now(),
		})
		JSONError(w, http.StatusUnauthorized, "invalid session")
		return
	}

	cfg := config.Get()
	policy := support.NewDefaultPolicy([]string{})
	if cfg != nil {
		policy.Allow = append(policy.Allow, cfg.Apps.DataPath, cfg.Logging.Path)
	}

	h.svc.LogAudit(r.Context(), &support.AuditEntry{
		SessionID:  sess.ID,
		Actor:      "support-session",
		Action:     "validate",
		Target:     "session",
		Success:    true,
		OccurredAt: time.Now(),
	})

	JSON(w, http.StatusOK, map[string]interface{}{
		"session": sess,
		"policy": map[string]interface{}{
			"allow": policy.Allow,
			"deny":  policy.Deny,
		},
	})
}
