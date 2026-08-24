package handlers

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
)

// recordSecurityEvent persists an audit event without failing the request it
// describes. The write is not worth a 500, but a dropped audit record is: on a
// WAN-exposed box the event log is the only trace of who did what, so a failure
// has to reach the logs instead of vanishing.
func recordSecurityEvent(ctx context.Context, svc *security.Service, event *security.Event) {
	if err := svc.RecordEvent(ctx, event); err != nil {
		slog.Error("Failed to record security event",
			"event_type", event.EventType,
			"actor", event.ActorUsername,
			"error", err,
		)
	}
}

type SecurityHandler struct {
	securityService *security.Service
}

func NewSecurityHandler(securityService *security.Service) *SecurityHandler {
	return &SecurityHandler{
		securityService: securityService,
	}
}

func (h *SecurityHandler) ListEvents(w http.ResponseWriter, r *http.Request) {
	filter := security.EventFilter{
		Limit:  100,
		Offset: 0,
	}

	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		l, err := strconv.Atoi(limitStr)
		if err != nil || l < 1 || l > 1000 {
			JSONError(w, http.StatusBadRequest, "The limit must be between 1 and 1000.")
			return
		}
		filter.Limit = l
	}

	if offsetStr := r.URL.Query().Get("offset"); offsetStr != "" {
		o, err := strconv.Atoi(offsetStr)
		if err != nil || o < 0 {
			JSONError(w, http.StatusBadRequest, "The offset must be 0 or greater.")
			return
		}
		filter.Offset = o
	}

	if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
		since, err := time.Parse(time.RFC3339, sinceStr)
		if err != nil {
			JSONError(w, http.StatusBadRequest, "The 'since' timestamp must be in RFC3339 format, e.g. 2026-01-01T00:00:00Z.")
			return
		}
		maxAge := time.Now().AddDate(0, 0, -90)
		if since.Before(maxAge) {
			since = maxAge
		}
		filter.Since = since
	}

	if eventType := r.URL.Query().Get("type"); eventType != "" {
		validTypes := map[string]bool{
			"login_success": true, "login_failed": true, "logout": true,
			"account_locked": true, "password_changed": true, "user_created": true,
			"user_deleted": true, "app_installed": true, "app_removed": true,
			"settings_changed": true, "suspicious_activity": true,
		}
		if !validTypes[eventType] {
			JSONError(w, http.StatusBadRequest, "That event type isn't valid.")
			return
		}
		filter.EventType = security.EventType(eventType)
	}

	if severity := r.URL.Query().Get("severity"); severity != "" {
		validSeverities := map[string]bool{
			"info": true, "warning": true, "critical": true,
		}
		if !validSeverities[severity] {
			JSONError(w, http.StatusBadRequest, "Severity must be info, warning, or critical.")
			return
		}
		filter.Severity = security.Severity(severity)
	}

	user := middleware.GetUser(r.Context())
	if user != nil && user.Role != "admin" {
		filter.ActorID = user.ID
	}

	result, err := h.securityService.ListEvents(r.Context(), filter)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load the security events. Please try again.")
		return
	}

	JSON(w, http.StatusOK, result)
}

func (h *SecurityHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUser(r.Context())
	if user == nil || user.Role != "admin" {
		JSONError(w, http.StatusForbidden, "You need administrator access to do that.")
		return
	}

	stats, err := h.securityService.GetStats(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load the security summary. Please try again.")
		return
	}

	JSON(w, http.StatusOK, stats)
}

func (h *SecurityHandler) GetHealth(w http.ResponseWriter, r *http.Request) {
	health := h.securityService.GetHealth()

	queueDepth, ok := health["queue_depth"].(int)
	if !ok {
		queueDepth = 0
	}
	queueCapacity, ok := health["queue_capacity"].(int)
	if !ok {
		queueCapacity = 100
	}

	if queueCapacity > 0 && float64(queueDepth)/float64(queueCapacity) > 0.8 {
		health["status"] = "degraded"
		health["warning"] = "Notification queue is nearly full"
	}

	JSON(w, http.StatusOK, health)
}

func getClientIP(r *http.Request) string {
	remoteIP := r.RemoteAddr
	if idx := strings.LastIndex(remoteIP, ":"); idx != -1 {
		remoteIP = remoteIP[:idx]
	}

	if !isTrustedProxy(remoteIP) {
		return remoteIP
	}

	xff := r.Header.Get("X-Forwarded-For")
	if xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			ip := strings.TrimSpace(parts[i])
			if ip != "" {
				return ip
			}
		}
	}

	xri := r.Header.Get("X-Real-IP")
	if xri != "" {
		return xri
	}

	return remoteIP
}

func isTrustedProxy(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, network := range middleware.TrustedProxyNets() {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
