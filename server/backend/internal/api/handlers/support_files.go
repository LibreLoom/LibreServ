package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

// SupportFileHandler serves file read/write endpoints for support sessions.
type SupportFileHandler struct {
	svc *support.Service
}

// NewSupportFileHandler creates a handler for support file operations.
func NewSupportFileHandler(svc *support.Service) *SupportFileHandler {
	return &SupportFileHandler{svc: svc}
}

type fileRequest struct {
	Code  string `json:"code"`
	Token string `json:"token"`
	Path  string `json:"path"`
	Data  string `json:"data,omitempty"` // for write
}

const maxFileSize = 2 * 1024 * 1024 // 2MB cap for safety

// Read handles POST /api/v1/support/files/read
func (h *SupportFileHandler) Read(w http.ResponseWriter, r *http.Request) {
	var req fileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	session, policy, err := h.validateSessionAndPolicy(req.Code, req.Token)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, "invalid session")
		return
	}
	if !hasScope(session.Scopes, "files-ro") && !hasScope(session.Scopes, "files-ro+docker") {
		JSONError(w, http.StatusForbidden, "scope files-ro required")
		return
	}
	allowed, err := policy.IsAllowed(req.Path)
	if err != nil || !allowed {
		JSONError(w, http.StatusForbidden, "path not allowed")
		h.svc.LogAudit(r.Context(), &support.AuditEntry{
			SessionID:  session.ID,
			Actor:      "support-session",
			Action:     "read",
			Target:     req.Path,
			Success:    false,
			Message:    "path denied",
			OccurredAt: time.Now(),
		})
		return
	}
	data, err := os.ReadFile(req.Path)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to read file")
		h.svc.LogAudit(r.Context(), &support.AuditEntry{
			SessionID:  session.ID,
			Actor:      "support-session",
			Action:     "read",
			Target:     req.Path,
			Success:    false,
			Message:    err.Error(),
			OccurredAt: time.Now(),
		})
		return
	}
	if len(data) > maxFileSize {
		JSONError(w, http.StatusRequestEntityTooLarge, "file too large")
		return
	}
	h.svc.LogAudit(r.Context(), &support.AuditEntry{
		SessionID:  session.ID,
		Actor:      "support-session",
		Action:     "read",
		Target:     req.Path,
		Success:    true,
		OccurredAt: time.Now(),
	})
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// Write handles POST /api/v1/support/files/write
func (h *SupportFileHandler) Write(w http.ResponseWriter, r *http.Request) {
	var req fileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	session, policy, err := h.validateSessionAndPolicy(req.Code, req.Token)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, "invalid session")
		return
	}
	if !hasScope(session.Scopes, "files-rw") && !hasScope(session.Scopes, "files-rw+docker") {
		JSONError(w, http.StatusForbidden, "scope files-rw required")
		return
	}
	allowed, err := policy.IsAllowed(req.Path)
	if err != nil || !allowed {
		JSONError(w, http.StatusForbidden, "path not allowed")
		h.svc.LogAudit(r.Context(), &support.AuditEntry{
			SessionID:  session.ID,
			Actor:      "support-session",
			Action:     "write",
			Target:     req.Path,
			Success:    false,
			Message:    "path denied",
			OccurredAt: time.Now(),
		})
		return
	}
	if req.Data == "" {
		body, _ := io.ReadAll(r.Body)
		req.Data = string(body)
	}
	if len(req.Data) > maxFileSize {
		JSONError(w, http.StatusRequestEntityTooLarge, "payload too large")
		return
	}
	if err := os.WriteFile(req.Path, []byte(req.Data), 0o644); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to write file")
		h.svc.LogAudit(r.Context(), &support.AuditEntry{
			SessionID:  session.ID,
			Actor:      "support-session",
			Action:     "write",
			Target:     req.Path,
			Success:    false,
			Message:    err.Error(),
			OccurredAt: time.Now(),
		})
		return
	}
	h.svc.LogAudit(r.Context(), &support.AuditEntry{
		SessionID:  session.ID,
		Actor:      "support-session",
		Action:     "write",
		Target:     req.Path,
		Success:    true,
		OccurredAt: time.Now(),
	})
	JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *SupportFileHandler) validateSessionAndPolicy(code, token string) (*support.Session, *support.PathPolicy, error) {
	if code == "" || token == "" {
		return nil, nil, errors.New("code and token required")
	}
	sess, err := h.svc.ValidateCode(context.Background(), code, token)
	if err != nil {
		return nil, nil, err
	}
	policy := support.NewDefaultPolicy(nil)
	cfg := config.Get()
	if cfg != nil {
		policy.Allow = append(policy.Allow, cfg.Apps.DataPath, cfg.Logging.Path)
	}
	// Deny docker internals always
	policy.Deny = append(policy.Deny, "/var/lib/docker")
	_ = policy.EnsureScratch("/tmp/libreserv-support")
	return sess, policy, nil
}

func hasScope(scopes []string, needed string) bool {
	for _, s := range scopes {
		if strings.EqualFold(s, needed) {
			return true
		}
	}
	return false
}
