package handlers

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
)

// SecurityHandler handles security monitoring API endpoints
type SecurityHandler struct {
	securityService *security.Service

	// Rate limiting for test notifications
	testNotificationMu        sync.Mutex
	testNotificationLastTime  map[string]time.Time // userID -> last test notification time
	testNotificationRateLimit time.Duration        // Minimum time between test notifications
}

// NewSecurityHandler creates a new SecurityHandler
func NewSecurityHandler(securityService *security.Service) *SecurityHandler {
	return &SecurityHandler{
		securityService:           securityService,
		testNotificationLastTime:  make(map[string]time.Time),
		testNotificationRateLimit: time.Minute, // 1 test per minute per user
	}
}

// ListEvents handles GET /api/v1/security/events
// Returns security events with optional filtering and pagination
func (h *SecurityHandler) ListEvents(w http.ResponseWriter, r *http.Request) {
	filter := security.EventFilter{
		Limit:  100,
		Offset: 0,
	}

	// Parse and validate limit parameter
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		l, err := strconv.Atoi(limitStr)
		if err != nil || l < 1 || l > 1000 {
			JSONError(w, http.StatusBadRequest, "invalid limit parameter: must be between 1 and 1000")
			return
		}
		filter.Limit = l
	}

	// Parse offset parameter for pagination
	if offsetStr := r.URL.Query().Get("offset"); offsetStr != "" {
		o, err := strconv.Atoi(offsetStr)
		if err != nil || o < 0 {
			JSONError(w, http.StatusBadRequest, "invalid offset parameter: must be non-negative")
			return
		}
		filter.Offset = o
	}

	// Parse since parameter
	if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
		since, err := time.Parse(time.RFC3339, sinceStr)
		if err != nil {
			JSONError(w, http.StatusBadRequest, "invalid since parameter: must be RFC3339 format")
			return
		}
		// Validate that since is not too old (max 90 days)
		maxAge := time.Now().AddDate(0, 0, -90)
		if since.Before(maxAge) {
			since = maxAge
		}
		filter.Since = since
	}

	// Validate event type if provided
	if eventType := r.URL.Query().Get("type"); eventType != "" {
		validTypes := map[string]bool{
			"login_success": true, "login_failed": true, "logout": true,
			"account_locked": true, "password_changed": true, "user_created": true,
			"user_deleted": true, "app_installed": true, "app_removed": true,
			"settings_changed": true, "suspicious_activity": true,
		}
		if !validTypes[eventType] {
			JSONError(w, http.StatusBadRequest, "invalid event type")
			return
		}
		filter.EventType = security.EventType(eventType)
	}

	// Validate severity if provided
	if severity := r.URL.Query().Get("severity"); severity != "" {
		validSeverities := map[string]bool{
			"info": true, "warning": true, "critical": true,
		}
		if !validSeverities[severity] {
			JSONError(w, http.StatusBadRequest, "invalid severity: must be info, warning, or critical")
			return
		}
		filter.Severity = security.Severity(severity)
	}

	// Allow filtering by current user unless admin
	user := middleware.GetUser(r.Context())
	if user != nil && user.Role != "admin" {
		filter.ActorID = user.ID
	}

	result, err := h.securityService.ListEvents(r.Context(), filter)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to list security events")
		return
	}

	JSON(w, http.StatusOK, result)
}

// GetStats handles GET /api/v1/security/stats
// Returns security statistics for the dashboard (admin only)
func (h *SecurityHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	// Only admins can view global statistics
	user := middleware.GetUser(r.Context())
	if user == nil || user.Role != "admin" {
		JSONError(w, http.StatusForbidden, "admin access required")
		return
	}

	stats, err := h.securityService.GetStats(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to get security stats")
		return
	}

	JSON(w, http.StatusOK, stats)
}

// GetSettings handles GET /api/v1/security/settings
// Returns security settings for the current user
func (h *SecurityHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	settings, err := h.securityService.GetUserSettings(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to get settings")
		return
	}

	JSON(w, http.StatusOK, settings)
}

// UpdateSettingsRequest represents a request to update security settings
type UpdateSettingsRequest struct {
	NotificationsEnabled   bool   `json:"notifications_enabled"`
	NotificationFrequency  string `json:"notification_frequency"`
	NotifyOnLogin          bool   `json:"notify_on_login"`
	NotifyOnFailedLogin    bool   `json:"notify_on_failed_login"`
	NotifyOnPasswordChange bool   `json:"notify_on_password_change"`
	NotifyOnAdminAction    bool   `json:"notify_on_admin_action"`
}

// Validate checks if the request is valid
func (r *UpdateSettingsRequest) Validate() error {
	validFrequencies := map[string]bool{
		"instant": true,
		"normal":  true,
		"digest":  true,
	}
	if !validFrequencies[r.NotificationFrequency] {
		return fmt.Errorf("notification_frequency must be one of: instant, normal, digest")
	}
	return nil
}

// UpdateSettings handles PUT /api/v1/security/settings
// Updates security settings for the current user
func (h *SecurityHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req UpdateSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate request
	if err := req.Validate(); err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	settings := &security.UserSettings{
		UserID:                 userID,
		NotificationsEnabled:   req.NotificationsEnabled,
		NotificationFrequency:  req.NotificationFrequency,
		NotifyOnLogin:          req.NotifyOnLogin,
		NotifyOnFailedLogin:    req.NotifyOnFailedLogin,
		NotifyOnPasswordChange: req.NotifyOnPasswordChange,
		NotifyOnAdminAction:    req.NotifyOnAdminAction,
	}

	if err := h.securityService.UpdateUserSettings(r.Context(), settings); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to update settings")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message": "settings updated",
	})
}

// TestNotification handles POST /api/v1/security/test-notification
// Sends a test notification to verify email configuration
func (h *SecurityHandler) TestNotification(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	// Check rate limiting
	h.testNotificationMu.Lock()
	lastTime, exists := h.testNotificationLastTime[userID]
	if exists && time.Since(lastTime) < h.testNotificationRateLimit {
		h.testNotificationMu.Unlock()
		timeRemaining := h.testNotificationRateLimit - time.Since(lastTime)
		JSONError(w, http.StatusTooManyRequests,
			fmt.Sprintf("Rate limit exceeded. Please wait %v before sending another test notification.", timeRemaining.Round(time.Second)))
		return
	}
	// Update last time
	h.testNotificationLastTime[userID] = time.Now()
	h.testNotificationMu.Unlock()

	user := middleware.GetUser(r.Context())

	// Get user settings
	settings, err := h.securityService.GetUserSettings(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to get settings")
		return
	}

	// Check if notifications are enabled
	if !settings.NotificationsEnabled {
		JSONError(w, http.StatusBadRequest, "notifications are disabled. Please enable them in settings first.")
		return
	}

	// Record a test event
	testEvent := security.Event{
		Timestamp:     time.Now(),
		EventType:     security.EventAdminAction,
		Severity:      security.SeverityInfo,
		ActorID:       userID,
		ActorUsername: user.Username,
		IPAddress:     getClientIP(r),
		UserAgent:     r.UserAgent(),
		Details:       "This is a test notification from your LibreServ security settings",
	}

	if err := h.securityService.RecordEvent(r.Context(), &testEvent); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to record test event")
		return
	}

	// Note: testEvent.ID is not reliable here as RecordEvent takes Event by value
	// The actual event ID would require passing by pointer or querying the database
	JSON(w, http.StatusOK, map[string]interface{}{
		"message":  "Test notification sent successfully",
		"settings": settings,
	})
}

// GetHealth handles GET /api/v1/security/health
// Returns health status and metrics for the security service
func (h *SecurityHandler) GetHealth(w http.ResponseWriter, r *http.Request) {
	// Get health status from security service
	health := h.securityService.GetHealth()

	// Check if service is healthy based on queue depth (use safe type assertions)
	queueDepth, ok := health["queue_depth"].(int)
	if !ok {
		queueDepth = 0
	}
	queueCapacity, ok := health["queue_capacity"].(int)
	if !ok {
		queueCapacity = 100 // Default capacity
	}

	// If queue is more than 80% full, report degraded status
	if queueCapacity > 0 && float64(queueDepth)/float64(queueCapacity) > 0.8 {
		health["status"] = "degraded"
		health["warning"] = "Notification queue is nearly full"
	}

	JSON(w, http.StatusOK, health)
}

// getClientIP extracts the client IP address from the request
// Security note: This function only trusts X-Forwarded-For from localhost/private networks
// to prevent IP spoofing attacks from external sources
func getClientIP(r *http.Request) string {
	// Get the remote address
	remoteIP := r.RemoteAddr
	if idx := strings.LastIndex(remoteIP, ":"); idx != -1 {
		remoteIP = remoteIP[:idx]
	}

	// Only check proxy headers if request comes from a trusted source
	// In production, this should be configured via settings
	if !isTrustedProxy(remoteIP) {
		return remoteIP
	}

	// Check X-Forwarded-For header (common for proxies)
	// Take the LAST IP added by the closest trusted proxy
	xff := r.Header.Get("X-Forwarded-For")
	if xff != "" {
		parts := strings.Split(xff, ",")
		// Get the last non-empty IP (closest to the server)
		for i := len(parts) - 1; i >= 0; i-- {
			ip := strings.TrimSpace(parts[i])
			if ip != "" {
				return ip
			}
		}
	}

	// Check X-Real-IP header (alternative proxy header)
	xri := r.Header.Get("X-Real-IP")
	if xri != "" {
		return xri
	}

	return remoteIP
}

// isTrustedProxy checks if the IP is from a trusted private network
// This prevents external attackers from spoofing their IP via headers
func isTrustedProxy(ipStr string) bool {
	// Parse the IP address
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}

	// Check if it's a loopback address (IPv4 or IPv6)
	if ip.IsLoopback() {
		return true
	}

	// Check if it's a private address
	if ip.IsPrivate() {
		return true
	}

	// Check for IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1)
	if ip4 := ip.To4(); ip4 != nil {
		// It's an IPv4-mapped IPv6 address, check if the IPv4 part is private
		ip4Str := ip4.String()
		ip4Parsed := net.ParseIP(ip4Str)
		if ip4Parsed != nil && (ip4Parsed.IsLoopback() || ip4Parsed.IsPrivate()) {
			return true
		}
	}

	// Check for IPv6 link-local addresses (fe80::/10)
	if ip.IsLinkLocalUnicast() {
		return true
	}

	return false
}
