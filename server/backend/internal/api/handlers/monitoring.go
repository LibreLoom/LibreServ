package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

// MonitoringHandlers handles monitoring-related API endpoints
type MonitoringHandlers struct {
	monitor *monitoring.Monitor
	db      *database.DB
	docker  *docker.Client
	mailer  func() (*email.Sender, error)
}

// NewMonitoringHandlers creates new monitoring handlers
func NewMonitoringHandlers(monitor *monitoring.Monitor, db *database.DB, dockerClient *docker.Client) *MonitoringHandlers {
	return &MonitoringHandlers{
		monitor: monitor,
		db:      db,
		docker:  dockerClient,
		mailer:  email.NewSender,
	}
}

// GetAppHealth returns the health status for an app
// GET /api/apps/{appID}/health
func (h *MonitoringHandlers) GetAppHealth(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appID")
	if appID == "" {
		JSONError(w, http.StatusBadRequest, "app ID required")
		return
	}

	health, err := h.monitor.GetAppHealth(r.Context(), appID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(health)
}

// GetAppMetrics returns current metrics for an app
// GET /api/apps/{appID}/metrics
func (h *MonitoringHandlers) GetAppMetrics(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appID")
	if appID == "" {
		JSONError(w, http.StatusBadRequest, "app ID required")
		return
	}

	metrics, err := h.monitor.GetAppMetrics(r.Context(), appID)
	if err != nil {
		if monitoring.IsDockerUnavailable(err) {
			JSONError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		if monitoring.IsNoContainers(err) {
			JSONError(w, http.StatusNotFound, err.Error())
			return
		}
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(metrics)
}

// GetMetricsHistory returns historical metrics for an app
// GET /api/apps/{appID}/metrics/history?since=2024-01-01T00:00:00Z&limit=100
func (h *MonitoringHandlers) GetMetricsHistory(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appID")
	if appID == "" {
		JSONError(w, http.StatusBadRequest, "app ID required")
		return
	}

	// Parse 'since' parameter (default: 24 hours ago)
	since := time.Now().Add(-24 * time.Hour)
	if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
		parsed, err := time.Parse(time.RFC3339, sinceStr)
		if err == nil {
			since = parsed
		}
	}

	// Parse 'limit' parameter (default: 100)
	limit := 100
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		parsed, err := strconv.Atoi(limitStr)
		if err == nil && parsed > 0 && parsed <= 1000 {
			limit = parsed
		}
	}

	metrics, err := h.monitor.GetMetricsHistory(r.Context(), appID, since, limit)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"app_id":  appID,
		"since":   since,
		"limit":   limit,
		"count":   len(metrics),
		"metrics": metrics,
	})
}

// RegisterHealthCheckRequest is the request body for registering health checks
type RegisterHealthCheckRequest struct {
	HTTP             *monitoring.HTTPCheckConfig      `json:"http,omitempty"`
	TCP              *monitoring.TCPCheckConfig       `json:"tcp,omitempty"`
	Container        *monitoring.ContainerCheckConfig `json:"container,omitempty"`
	IntervalSeconds  int                              `json:"interval_seconds"`
	TimeoutSeconds   int                              `json:"timeout_seconds"`
	FailureThreshold int                              `json:"failure_threshold"`
	SuccessThreshold int                              `json:"success_threshold"`
}

// RegisterHealthCheck registers health checks for an app
// POST /api/apps/{appID}/health/register
func (h *MonitoringHandlers) RegisterHealthCheck(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appID")
	if appID == "" {
		JSONError(w, http.StatusBadRequest, "app ID required")
		return
	}

	var req RegisterHealthCheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	config := monitoring.HealthCheckConfig{
		HTTP:             req.HTTP,
		TCP:              req.TCP,
		Container:        req.Container,
		Interval:         time.Duration(req.IntervalSeconds) * time.Second,
		Timeout:          time.Duration(req.TimeoutSeconds) * time.Second,
		FailureThreshold: req.FailureThreshold,
		SuccessThreshold: req.SuccessThreshold,
	}

	if err := h.monitor.RegisterApp(appID, config); err != nil {
		if monitoring.IsDockerUnavailable(err) {
			JSONError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "registered",
		"app_id":  appID,
		"message": "Health checks registered successfully",
	})
}

// UnregisterHealthCheck removes health checks for an app
// DELETE /api/apps/{appID}/health
func (h *MonitoringHandlers) UnregisterHealthCheck(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appID")
	if appID == "" {
		http.Error(w, "app ID required", http.StatusBadRequest)
		return
	}

	h.monitor.UnregisterApp(appID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "unregistered",
		"app_id":  appID,
		"message": "Health checks unregistered",
	})
}

// SystemHealth returns overall system health
// GET /api/system/health
func (h *MonitoringHandlers) SystemHealth(w http.ResponseWriter, r *http.Request) {
	dbStatus := "healthy"
	if err := h.db.HealthCheck(); err != nil {
		dbStatus = "unhealthy"
	}

	dockerStatus := "unknown"
	if h.docker != nil {
		if err := h.docker.HealthCheck(); err != nil {
			dockerStatus = "unhealthy"
		} else {
			dockerStatus = "healthy"
		}
	}

	smtpStatus := "not_configured"
	if err := email.HealthCheck(); err != nil {
		if err.Error() == "smtp not configured" {
			smtpStatus = "not_configured"
		} else {
			smtpStatus = "unhealthy"
		}
	} else {
		smtpStatus = "healthy"
	}

	response := map[string]interface{}{
		"status":    "healthy",
		"timestamp": time.Now(),
		"checks": map[string]interface{}{
			"api":      "healthy",
			"database": dbStatus,
			"docker":   dockerStatus,
			"smtp":     smtpStatus,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// CleanupMetrics removes old monitoring data
// POST /api/system/monitoring/cleanup?retention_days=7
func (h *MonitoringHandlers) CleanupMetrics(w http.ResponseWriter, r *http.Request) {
	// Parse retention days (default: 7)
	retentionDays := 7
	if daysStr := r.URL.Query().Get("retention_days"); daysStr != "" {
		parsed, err := strconv.Atoi(daysStr)
		if err == nil && parsed > 0 {
			retentionDays = parsed
		}
	}

	retention := time.Duration(retentionDays) * 24 * time.Hour
	if err := h.monitor.CleanupOldData(retention); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":         "cleaned",
		"retention_days": retentionDays,
		"message":        "Old monitoring data cleaned up",
	})
}

// SendTestEmail sends a test email to verify SMTP configuration
// POST /api/system/email/test { "to": "user@example.com" }
func (h *MonitoringHandlers) SendTestEmail(w http.ResponseWriter, r *http.Request) {
	if h.mailer == nil {
		JSONError(w, http.StatusInternalServerError, "mailer not configured")
		return
	}
	var body struct {
		To   string             `json:"to"`
		SMTP *config.SMTPConfig `json:"smtp,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.To == "" {
		JSONError(w, http.StatusBadRequest, "to is required")
		return
	}
	var mailer *email.Sender
	var err error
	if body.SMTP != nil {
		mailer, err = email.NewSenderWithConfig(*body.SMTP)
	} else {
		mailer, err = h.mailer()
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "smtp setup error: "+err.Error())
		return
	}
	if err := mailer.Send([]string{body.To}, "LibreServ SMTP Test", "This is a test email from LibreServ."); err != nil {
		JSONError(w, http.StatusInternalServerError, "send failed: "+err.Error())
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "sent",
		"to":     body.To,
	})
}
