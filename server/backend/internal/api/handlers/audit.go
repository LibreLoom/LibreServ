package handlers

import (
	"net/http"
	"strconv"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/audit"
)

// AuditHandler handles audit log API endpoints
type AuditHandler struct {
	service *audit.Service
}

// NewAuditHandler creates a new AuditHandler
func NewAuditHandler(service *audit.Service) *AuditHandler {
	return &AuditHandler{
		service: service,
	}
}

// ListLogs handles GET /api/v1/audit
func (h *AuditHandler) ListLogs(w http.ResponseWriter, r *http.Request) {
	limitStr := r.URL.Query().Get("limit")
	limit := 100
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil {
			limit = l
		}
	}

	entries, err := h.service.List(r.Context(), limit)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to list audit logs: "+err.Error())
		return
	}

	JSON(w, http.StatusOK, entries)
}
