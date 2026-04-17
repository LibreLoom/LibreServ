package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
)

type SettingsHandler struct {
	settingsService *settings.Service
	securityService *security.Service

	testNotificationMu        sync.Mutex
	testNotificationLastTime  map[string]time.Time
	testNotificationRateLimit time.Duration
}

func NewSettingsHandler(settingsService *settings.Service, securityService *security.Service) *SettingsHandler {
	h := &SettingsHandler{
		settingsService:           settingsService,
		securityService:           securityService,
		testNotificationLastTime:  make(map[string]time.Time),
		testNotificationRateLimit: time.Minute,
	}

	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			h.testNotificationMu.Lock()
			cutoff := time.Now().Add(-h.testNotificationRateLimit * 2)
			for k, t := range h.testNotificationLastTime {
				if t.Before(cutoff) {
					delete(h.testNotificationLastTime, k)
				}
			}
			h.testNotificationMu.Unlock()
		}
	}()

	return h
}

func (h *SettingsHandler) Get(w http.ResponseWriter, r *http.Request) {
	if h.settingsService != nil {
		result, err := h.settingsService.GetSettings(r.Context())
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "failed to get settings")
			return
		}
		JSON(w, http.StatusOK, result)
		return
	}

	cfg := config.Get()
	if cfg == nil {
		JSONError(w, http.StatusInternalServerError, "configuration not loaded")
		return
	}

	response := map[string]interface{}{
		"server": map[string]interface{}{
			"host": cfg.Server.Host,
			"port": cfg.Server.Port,
			"mode": cfg.Server.Mode,
		},
		"logging": map[string]interface{}{
			"level": cfg.Logging.Level,
			"path":  cfg.Logging.Path,
		},
	}

	if cfg.Network.Caddy.Mode != "" || cfg.Network.Caddy.AdminAPI != "" {
		proxyInfo := map[string]interface{}{
			"type": "caddy",
		}
		if cfg.Network.Caddy.Mode != "" {
			proxyInfo["mode"] = cfg.Network.Caddy.Mode
		}
		if cfg.Network.Caddy.AdminAPI != "" {
			proxyInfo["admin_api"] = cfg.Network.Caddy.AdminAPI
		}
		if cfg.Network.Caddy.ConfigPath != "" {
			proxyInfo["config_path"] = cfg.Network.Caddy.ConfigPath
		}
		if cfg.Network.Caddy.DefaultDomain != "" {
			proxyInfo["default_domain"] = cfg.Network.Caddy.DefaultDomain
		}
		proxyInfo["auto_https"] = cfg.Network.Caddy.AutoHTTPS
		response["proxy"] = proxyInfo
	}

	JSON(w, http.StatusOK, response)
}

func (h *SettingsHandler) Update(w http.ResponseWriter, r *http.Request) {
	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if h.settingsService == nil {
		JSONError(w, http.StatusInternalServerError, "settings service not available")
		return
	}

	if err := h.settingsService.UpdateSettings(r.Context(), updates); err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	result, _ := h.settingsService.GetSettings(r.Context())
	JSON(w, http.StatusOK, map[string]interface{}{
		"message":  "settings updated",
		"settings": result,
	})
}

func (h *SettingsHandler) GetSecurity(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	s, err := h.securityService.GetUserSettings(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to get settings")
		return
	}
	JSON(w, http.StatusOK, s)
}

func (h *SettingsHandler) UpdateSecurity(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req securitySettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	validFrequencies := map[string]bool{"instant": true, "normal": true, "digest": true}
	if !validFrequencies[req.NotificationFrequency] {
		JSONError(w, http.StatusBadRequest, "notification_frequency must be one of: instant, normal, digest")
		return
	}

	s := &security.UserSettings{
		UserID:                 userID,
		NotificationsEnabled:   req.NotificationsEnabled,
		NotificationFrequency:  req.NotificationFrequency,
		NotifyOnLogin:          req.NotifyOnLogin,
		NotifyOnFailedLogin:    req.NotifyOnFailedLogin,
		NotifyOnPasswordChange: req.NotifyOnPasswordChange,
		NotifyOnAdminAction:    req.NotifyOnAdminAction,
		Use12HourTime:          req.Use12HourTime,
	}

	if err := h.securityService.UpdateUserSettings(r.Context(), s); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to update settings")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "settings updated"})
}

type securitySettingsRequest struct {
	NotificationsEnabled   bool   `json:"notifications_enabled"`
	NotificationFrequency  string `json:"notification_frequency"`
	NotifyOnLogin          bool   `json:"notify_on_login"`
	NotifyOnFailedLogin    bool   `json:"notify_on_failed_login"`
	NotifyOnPasswordChange bool   `json:"notify_on_password_change"`
	NotifyOnAdminAction    bool   `json:"notify_on_admin_action"`
	Use12HourTime          bool   `json:"use_12_hour_time"`
}

func (h *SettingsHandler) GetNotifications(w http.ResponseWriter, r *http.Request) {
	result, err := h.settingsService.GetSettings(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to get settings")
		return
	}

	notifications := map[string]interface{}{
		"smtp":   result["smtp"],
		"notify": result["notify"],
	}

	smtp, _ := result["smtp"].(map[string]interface{})
	if smtp != nil {
		smtp["password"] = ""
	}

	JSON(w, http.StatusOK, notifications)
}

func (h *SettingsHandler) UpdateNotifications(w http.ResponseWriter, r *http.Request) {
	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	filtered := map[string]interface{}{}
	if v, ok := updates["smtp"]; ok {
		filtered["smtp"] = v
	}
	if v, ok := updates["notify"]; ok {
		filtered["notify"] = v
	}
	if len(filtered) == 0 {
		JSONError(w, http.StatusBadRequest, "no notification settings provided")
		return
	}

	if err := h.settingsService.UpdateSettings(r.Context(), filtered); err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	result, _ := h.settingsService.GetSettings(r.Context())
	smtp, _ := result["smtp"].(map[string]interface{})
	if smtp != nil {
		smtp["password"] = ""
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"message": "notification settings updated",
		"smtp":    result["smtp"],
		"notify":  result["notify"],
	})
}

func (h *SettingsHandler) PreviewTemplate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Template string            `json:"template"`
		Data     map[string]string `json:"data"`
	}
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

func (h *SettingsHandler) TestNotification(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	h.testNotificationMu.Lock()
	lastTime, exists := h.testNotificationLastTime[userID]
	if exists && time.Since(lastTime) < h.testNotificationRateLimit {
		h.testNotificationMu.Unlock()
		timeRemaining := h.testNotificationRateLimit - time.Since(lastTime)
		JSONError(w, http.StatusTooManyRequests,
			fmt.Sprintf("Rate limit exceeded. Please wait %v before sending another test notification.", timeRemaining.Round(time.Second)))
		return
	}
	h.testNotificationLastTime[userID] = time.Now()
	h.testNotificationMu.Unlock()

	user := middleware.GetUser(r.Context())

	s, err := h.securityService.GetUserSettings(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to get settings")
		return
	}

	if !s.NotificationsEnabled {
		JSONError(w, http.StatusBadRequest, "notifications are disabled. Please enable them in settings first.")
		return
	}

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

	JSON(w, http.StatusOK, map[string]interface{}{
		"message":  "Test notification sent successfully",
		"settings": s,
	})
}

func (h *SettingsHandler) UpdateProxy(w http.ResponseWriter, r *http.Request) {
	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate inputs
	if defaultDomain, ok := updates["default_domain"].(string); ok && defaultDomain != "" {
		if err := validateDomain(defaultDomain); err != nil {
			JSONError(w, http.StatusBadRequest, "invalid default_domain: "+err.Error())
			return
		}
	}

	if sslEmail, ok := updates["ssl_email"].(string); ok && sslEmail != "" {
		if err := validateEmail(sslEmail); err != nil {
			JSONError(w, http.StatusBadRequest, "invalid ssl_email: "+err.Error())
			return
		}
	}

	if autoHTTPS, ok := updates["auto_https"]; ok {
		if _, ok := autoHTTPS.(bool); !ok {
			JSONError(w, http.StatusBadRequest, "auto_https must be a boolean")
			return
		}
	}

	if h.settingsService == nil {
		JSONError(w, http.StatusInternalServerError, "settings service not available")
		return
	}

	// Wrap updates in proxy object to match UpdateSettings expectations
	proxyUpdates := map[string]interface{}{"proxy": updates}
	if err := h.settingsService.UpdateSettings(r.Context(), proxyUpdates); err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	result, _ := h.settingsService.GetSettings(r.Context())
	JSON(w, http.StatusOK, result)
}

// validateDomain validates a domain name format
func validateDomain(domain string) error {
	if domain == "" {
		return nil
	}
	// Basic domain validation: letters, numbers, hyphens, dots
	// Must not start or end with hyphen or dot
	// Must have at least one dot for TLD
	if len(domain) > 253 {
		return fmt.Errorf("domain too long (max 253 characters)")
	}
	if domain[0] == '-' || domain[len(domain)-1] == '-' {
		return fmt.Errorf("domain cannot start or end with a hyphen")
	}
	if domain[0] == '.' || domain[len(domain)-1] == '.' {
		return fmt.Errorf("domain cannot start or end with a dot")
	}
	// Check for valid characters
	for i, r := range domain {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '.') {
			return fmt.Errorf("invalid character at position %d: %c", i, r)
		}
	}
	// Must have at least one dot for TLD
	if !strings.Contains(domain, ".") {
		return fmt.Errorf("domain must include a TLD (e.g., .com, .org)")
	}
	return nil
}

// validateEmail validates an email address format
func validateEmail(email string) error {
	if email == "" {
		return nil
	}
	// Basic email validation: must have @ and domain
	if !strings.Contains(email, "@") {
		return fmt.Errorf("email must contain @")
	}
	parts := strings.Split(email, "@")
	if len(parts) != 2 {
		return fmt.Errorf("email must have exactly one @")
	}
	if len(parts[0]) == 0 {
		return fmt.Errorf("email username cannot be empty")
	}
	if len(parts[1]) == 0 {
		return fmt.Errorf("email domain cannot be empty")
	}
	if !strings.Contains(parts[1], ".") {
		return fmt.Errorf("email domain must include a TLD")
	}
	return nil
}
