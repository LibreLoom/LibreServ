package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

// SupportHandler manages support session endpoints.
type SupportHandler struct {
	svc     *support.Service
	license middleware.LicenseChecker
	mailer  func() (*email.Sender, error)
}

func NewSupportHandler(svc *support.Service, lic middleware.LicenseChecker) *SupportHandler {
	return &SupportHandler{svc: svc, license: lic, mailer: email.NewSender}
}

type createSessionRequest struct {
	Scopes []string `json:"scopes"`
	TTL    string   `json:"ttl"` // e.g., "1h", "30m"
}

func (h *SupportHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	if h.license != nil && !h.license.Valid() {
		JSONError(w, http.StatusForbidden, "support requires a valid license: "+h.license.Reason())
		return
	}
	var req createSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ttl := time.Hour
	if req.TTL != "" {
		if d, err := time.ParseDuration(req.TTL); err == nil {
			ttl = d
		}
	}

	user := middleware.GetUser(r.Context())
	createdBy := ""
	if user != nil {
		createdBy = user.Username
	}

	sess, err := h.svc.CreateSession(r.Context(), support.CreateRequest{
		Scopes:    req.Scopes,
		TTL:       ttl,
		CreatedBy: createdBy,
	})
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to create session: "+err.Error())
		return
	}

	// Notify support recipients if configured
	go h.notifySupport(sess)

	JSON(w, http.StatusCreated, sess)
}

func (h *SupportHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil {
			limit = v
		}
	}
	sessions, err := h.svc.ListSessions(r.Context(), limit)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to list sessions: "+err.Error())
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{
		"sessions": sessions,
		"count":    len(sessions),
	})
}

// GetSession returns a single session by ID.
func (h *SupportHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "sessionID")
	if id == "" {
		JSONError(w, http.StatusBadRequest, "session id required")
		return
	}
	sess, err := h.svc.GetSession(r.Context(), id)
	if err != nil {
		JSONError(w, http.StatusNotFound, "session not found")
		return
	}
	JSON(w, http.StatusOK, sess)
}

func (h *SupportHandler) RevokeSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "sessionID")
	if id == "" {
		JSONError(w, http.StatusBadRequest, "session id required")
		return
	}
	user := middleware.GetUser(r.Context())
	by := ""
	if user != nil {
		by = user.Username
	}
	if err := h.svc.RevokeSession(r.Context(), id, by); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to revoke session: "+err.Error())
		return
	}
	JSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

func (h *SupportHandler) notifySupport(sess *support.Session) {
	cfg := config.Get()
	if cfg == nil || !cfg.Notify.Enabled || len(cfg.Notify.SupportRecipients) == 0 {
		return
	}
	if h.mailer == nil {
		return
	}
	m, err := h.mailer()
	if err != nil {
		return
	}
	data := map[string]string{
		"Code":      sess.Code,
		"Token":     sess.Token,
		"Expires":   sess.ExpiresAt.String(),
		"Scopes":    strings.Join(sess.Scopes, ","),
		"CreatedBy": sess.CreatedBy,
	}
	bodyTmpl := cfg.Notify.SupportBody
	if bodyTmpl == "" {
		bodyTmpl = "A support session was created.\n\nCode: {{.Code}}\nToken: {{.Token}}\nExpires: {{.Expires}}\nScopes: {{.Scopes}}\nCreated By: {{.CreatedBy}}\n"
	}
	subject := cfg.Notify.SupportSubject
	if subject == "" {
		subject = "LibreServ support session created"
	}
	body, err := email.RenderTemplate(bodyTmpl, data)
	if err != nil {
		body = "A support session was created. Code: " + sess.Code
	}
	_ = m.Send(cfg.Notify.SupportRecipients, subject, body)
}
