package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

// HealthCheckResult represents the result of a single health check
type HealthCheckResult struct {
	Status   string      `json:"status"`
	Message  string      `json:"message,omitempty"`
	Details  interface{} `json:"details,omitempty"`
	Category string      `json:"category"`
}

// ComprehensiveHealthResponse represents the full system health check response
type ComprehensiveHealthResponse struct {
	Status      string                        `json:"status"`
	Timestamp   time.Time                     `json:"timestamp"`
	OverallPass bool                          `json:"overall_pass"`
	Checks      map[string]*HealthCheckResult `json:"checks"`
	Summary     HealthCheckSummary            `json:"summary"`
}

// HealthCheckSummary provides aggregated health status
type HealthCheckSummary struct {
	TotalChecks  int `json:"total_checks"`
	Passed       int `json:"passed"`
	Failed       int `json:"failed"`
	WarningCount int `json:"warning_count"`
	SystemHealth struct {
		CPUPercent    float64 `json:"cpu_percent"`
		MemoryPercent float64 `json:"memory_percent"`
		DiskPercent   float64 `json:"disk_percent"`
		DiskFreeBytes uint64  `json:"disk_free_bytes"`
		DiskFreeHuman string  `json:"disk_free_human"`
	} `json:"system_health"`
}

// FailureTracker tracks consecutive failures for health checks
type FailureTracker struct {
	mu            sync.RWMutex
	failureCounts map[string]int
	lastAlertTime map[string]time.Time
	minAlertGap   time.Duration
}

func NewFailureTracker() *FailureTracker {
	return &FailureTracker{
		failureCounts: make(map[string]int),
		lastAlertTime: make(map[string]time.Time),
		minAlertGap:   5 * time.Minute,
	}
}

func (ft *FailureTracker) RecordFailure(checkName string) int {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	ft.failureCounts[checkName]++
	return ft.failureCounts[checkName]
}

func (ft *FailureTracker) RecordSuccess(checkName string) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	ft.failureCounts[checkName] = 0
}

func (ft *FailureTracker) GetCount(checkName string) int {
	ft.mu.RLock()
	defer ft.mu.RUnlock()
	return ft.failureCounts[checkName]
}

func (ft *FailureTracker) CanAlert(checkName string) bool {
	ft.mu.RLock()
	defer ft.mu.RUnlock()
	lastTime, exists := ft.lastAlertTime[checkName]
	if !exists {
		return true
	}
	return time.Since(lastTime) > ft.minAlertGap
}

func (ft *FailureTracker) RecordAlert(checkName string) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	ft.lastAlertTime[checkName] = time.Now()
}

// HealthCheckCache provides cached health check results with automatic refresh
type HealthCheckCache struct {
	mu             sync.RWMutex
	lastResult     *ComprehensiveHealthResponse
	lastChecked    time.Time
	cacheDur       time.Duration
	refreshing     bool
	failureTracker *FailureTracker
}

func NewHealthCheckCache(cacheDur time.Duration) *HealthCheckCache {
	return &HealthCheckCache{
		cacheDur:       cacheDur,
		failureTracker: NewFailureTracker(),
	}
}

func (hcc *HealthCheckCache) Get() *ComprehensiveHealthResponse {
	hcc.mu.RLock()
	defer hcc.mu.RUnlock()
	return hcc.lastResult
}

func (hcc *HealthCheckCache) ShouldRefresh() bool {
	hcc.mu.RLock()
	defer hcc.mu.RUnlock()
	if hcc.lastResult == nil {
		return true
	}
	return time.Since(hcc.lastChecked) > hcc.cacheDur
}

func (hcc *HealthCheckCache) Set(result *ComprehensiveHealthResponse) {
	hcc.mu.Lock()
	defer hcc.mu.Unlock()
	hcc.lastResult = result
	hcc.lastChecked = time.Now()
}

// MonitoringHandlers handles monitoring-related API endpoints
type MonitoringHandlers struct {
	monitor      *monitoring.Monitor
	db           *database.DB
	docker       *docker.Client
	mailer       func() (*email.Sender, error)
	metricsCache *apps.AppMetricsCache
	healthCache  *HealthCheckCache
}

// NewMonitoringHandlers creates new monitoring handlers
func NewMonitoringHandlers(monitor *monitoring.Monitor, db *database.DB, dockerClient *docker.Client, metricsCache *apps.AppMetricsCache) *MonitoringHandlers {
	h := &MonitoringHandlers{
		monitor:      monitor,
		db:           db,
		docker:       dockerClient,
		mailer:       email.NewSender,
		metricsCache: metricsCache,
		healthCache:  NewHealthCheckCache(30 * time.Second),
	}
	// Start background refresh
	go h.backgroundRefresh()
	return h
}

func (h *MonitoringHandlers) backgroundRefresh() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if h.healthCache.ShouldRefresh() && !h.healthCache.refreshing {
			h.healthCache.refreshing = true
			ctx := context.Background()
			result := h.runComprehensiveHealthChecks(ctx)
			h.healthCache.Set(result)
			h.healthCache.refreshing = false
		}
	}
}

// sendHealthAlert sends email alerts to all admin users for health check failures
func (h *MonitoringHandlers) sendHealthAlert(failedChecks []string, result *ComprehensiveHealthResponse) {
	cfg := config.Get()
	if cfg == nil || !cfg.Notify.Enabled {
		return
	}

	// Get all admin users
	admins, err := h.db.GetAdminUsers(context.Background())
	if err != nil {
		slog.Error("Failed to get admin users for health alert", "error", err)
		return
	}

	if len(admins) == 0 {
		slog.Warn("No admin users found for health alert")
		return
	}

	// Build recipient list
	recipients := make([]string, 0, len(admins))
	for _, admin := range admins {
		if admin.Email != "" {
			recipients = append(recipients, admin.Email)
		}
	}

	if len(recipients) == 0 {
		slog.Warn("No admin emails configured for health alerts")
		return
	}

	// Send alert
	mailer, err := h.mailer()
	if err != nil {
		slog.Error("Mailer not configured for health alert", "error", err)
		return
	}

	// Build email content
	failedChecksStr := strings.Join(failedChecks, ", ")
	templateData := map[string]interface{}{
		"HealthCheck": failedChecksStr,
		"Status":      result.Status,
		"Timestamp":   result.Timestamp.Format(time.RFC1123),
		"Body": fmt.Sprintf(`Hello,

LibreServ has detected %d health issue(s):

<strong>%s</strong>

Status: %s
Time: %s
Failed Checks: %d / %d

Please check your system as soon as possible.

— LibreServ`, len(failedChecks), failedChecksStr, result.Status, result.Timestamp.Format(time.RFC1123), result.Summary.Failed, result.Summary.TotalChecks),
	}

	subject, body, err := email.RenderTemplateByKey("health_alert", templateData)
	if err != nil {
		slog.Error("Failed to render health alert template", "error", err)
		subject = "⚠️ LibreServ Health Alert"
		body = fmt.Sprintf("Health check failed: %s", failedChecksStr)
	}

	// Try HTML first, fallback to plain text
	htmlBody, err := email.RenderHTMLEmail(subject, body, templateData)
	if err != nil {
		slog.Warn("Failed to render HTML email, using plain text", "error", err)
		if err := mailer.Send(recipients, subject, body); err != nil {
			slog.Error("Failed to send health alert email", "error", err)
		}
	} else {
		if err := mailer.SendHTMLEmail(recipients, subject, htmlBody); err != nil {
			slog.Error("Failed to send health alert HTML email", "error", err)
		}
	}

	slog.Info("Health alert sent", "recipients", len(recipients), "failed_checks", failedChecksStr)
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
		JSONError(w, http.StatusInternalServerError, "failed to retrieve health status")
		return
	}

	JSON(w, http.StatusOK, health)
}

// GetAppMetrics returns current metrics for an app
// GET /api/apps/{appID}/metrics
func (h *MonitoringHandlers) GetAppMetrics(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appID")
	if appID == "" {
		JSONError(w, http.StatusBadRequest, "app ID required")
		return
	}

	if h.metricsCache != nil {
		cached := h.metricsCache.GetMetrics(appID)
		if cached != nil {
			metrics := &monitoring.Metrics{
				AppID:       appID,
				Timestamp:   time.Now(),
				CPUPercent:  cached.CPUPercent,
				MemoryUsage: cached.MemoryUsage,
				MemoryLimit: cached.MemoryLimit,
				NetworkRx:   cached.NetworkRx,
				NetworkTx:   cached.NetworkTx,
			}
			JSON(w, http.StatusOK, metrics)
			return
		}
	}

	metrics, err := h.monitor.GetAppMetrics(r.Context(), appID)
	if err != nil {
		if monitoring.IsDockerUnavailable(err) {
			JSONError(w, http.StatusServiceUnavailable, "docker service unavailable")
			return
		}
		if monitoring.IsNoContainers(err) {
			JSONError(w, http.StatusNotFound, "no containers found for app")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to retrieve metrics")
		return
	}

	JSON(w, http.StatusOK, metrics)
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
		JSONError(w, http.StatusInternalServerError, "failed to retrieve metrics history")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
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
			JSONError(w, http.StatusServiceUnavailable, "docker service unavailable")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to register health checks")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
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

	JSON(w, http.StatusOK, map[string]interface{}{
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

	cached := h.monitor.GetCachedSystemResources()

	if cached == nil {
		h.monitor.CollectAndCacheSystemResourcesSync()
		cached = h.monitor.GetCachedSystemResources()
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
		"resources":          cached.Resources,
		"system_metrics":     cached.SystemMetrics,
		"running_containers": cached.RunningContainers,
	}

	JSON(w, http.StatusOK, response)
}

// ComprehensiveHealthCheck returns a comprehensive system health check
// GET /api/system/health/check
// POST /api/system/health/check/refresh (forces refresh)
func (h *MonitoringHandlers) ComprehensiveHealthCheck(w http.ResponseWriter, r *http.Request) {
	forceRefresh := r.Method == http.MethodPost

	var result *ComprehensiveHealthResponse

	if forceRefresh || h.healthCache.ShouldRefresh() {
		h.healthCache.refreshing = true
		result = h.runComprehensiveHealthChecks(r.Context())
		h.healthCache.Set(result)
		h.healthCache.refreshing = false
	} else {
		result = h.healthCache.Get()
		if result == nil {
			result = h.runComprehensiveHealthChecks(r.Context())
			h.healthCache.Set(result)
		}
	}

	statusCode := http.StatusOK
	if !result.OverallPass {
		statusCode = http.StatusServiceUnavailable
	}

	JSON(w, statusCode, result)
}

func (h *MonitoringHandlers) runComprehensiveHealthChecks(ctx context.Context) *ComprehensiveHealthResponse {
	cfg := config.Get()
	if cfg == nil {
		return &ComprehensiveHealthResponse{
			Status:      "error",
			Timestamp:   time.Now(),
			OverallPass: false,
			Checks:      map[string]*HealthCheckResult{},
			Summary:     HealthCheckSummary{},
		}
	}

	checks := make(map[string]*HealthCheckResult)
	overallPass := true

	// Helper to run and categorize checks
	runCheck := func(name, category string, fn func() (bool, string, interface{})) {
		passed, message, details := fn()
		status := "passed"
		if !passed {
			status = "failed"
			overallPass = false
		}
		checks[name] = &HealthCheckResult{
			Status:   status,
			Message:  message,
			Details:  details,
			Category: category,
		}
	}

	// System Checks
	runCheck("database", "system", func() (bool, string, interface{}) {
		if err := h.db.HealthCheck(); err != nil {
			return false, "Database connection failed: " + err.Error(), nil
		}
		return true, "Database connection successful", nil
	})

	runCheck("docker", "system", func() (bool, string, interface{}) {
		if h.docker == nil {
			return false, "Docker client not initialized", nil
		}
		if err := h.docker.HealthCheck(); err != nil {
			return false, "Docker daemon unreachable: " + err.Error(), nil
		}
		return true, "Docker daemon is running", nil
	})

	runCheck("api_server", "system", func() (bool, string, interface{}) {
		return true, "API server is running", nil
	})

	// Storage Checks
	runCheck("database_path_writable", "storage", func() (bool, string, interface{}) {
		return checkPathWritableHealth(filepath.Dir(cfg.Database.Path), cfg)
	})

	runCheck("data_path_writable", "storage", func() (bool, string, interface{}) {
		return checkPathWritableHealth(cfg.Apps.DataPath, cfg)
	})

	runCheck("logs_path_writable", "storage", func() (bool, string, interface{}) {
		return checkPathWritableHealth(cfg.Logging.Path, cfg)
	})

	// Caddy/Network Checks (if enabled)
	if cfg.Network.Caddy.Mode != "disabled" && cfg.Network.Caddy.Mode != "noop" {
		if cfg.Network.Caddy.ConfigPath != "" {
			runCheck("caddy_config_writable", "network", func() (bool, string, interface{}) {
				return checkPathWritableHealth(cfg.Network.Caddy.ConfigPath, cfg)
			})
		}
		if cfg.Network.Caddy.CertsPath != "" {
			runCheck("caddy_certs_writable", "network", func() (bool, string, interface{}) {
				return checkPathWritableHealth(cfg.Network.Caddy.CertsPath, cfg)
			})
		}
	}

	// ACME Checks (if enabled)
	if cfg.Network.ACME.External.Enabled {
		if cfg.Network.ACME.External.DataPath != "" {
			runCheck("acme_data_writable", "network", func() (bool, string, interface{}) {
				return checkPathWritableHealth(cfg.Network.ACME.External.DataPath, cfg)
			})
		}
		if cfg.Network.ACME.External.CertsPath != "" {
			runCheck("acme_certs_writable", "network", func() (bool, string, interface{}) {
				return checkPathWritableHealth(cfg.Network.ACME.External.CertsPath, cfg)
			})
		}
	}

	// SMTP Check
	runCheck("smtp", "network", func() (bool, string, interface{}) {
		if err := email.HealthCheck(); err != nil {
			if err.Error() == "smtp not configured" {
				return true, "SMTP not configured (optional)", map[string]interface{}{"optional": true}
			}
			return false, "SMTP connection failed: " + err.Error(), nil
		}
		return true, "SMTP server reachable", nil
	})

	// Disk Space Check
	var diskFree uint64
	var diskTotal uint64
	runCheck("disk_space", "system", func() (bool, string, interface{}) {
		resolvedPath, err := resolveConfigPathHealth(cfg.Apps.DataPath)
		if err != nil {
			return false, "Cannot resolve data path", nil
		}
		var stat syscall.Statfs_t
		if err := syscall.Statfs(resolvedPath, &stat); err != nil {
			return false, "Cannot stat disk: " + err.Error(), nil
		}
		diskFree = stat.Bavail * uint64(stat.Bsize)
		diskTotal = stat.Blocks * uint64(stat.Bsize)

		if diskFree < 512*1024*1024 {
			return false, "Low disk space (< 512MB free)", map[string]interface{}{
				"free_bytes": diskFree,
				"free_human": formatBytes(diskFree),
			}
		}
		return true, fmt.Sprintf("%s free", formatBytes(diskFree)), map[string]interface{}{
			"free_bytes":  diskFree,
			"total_bytes": diskTotal,
			"free_human":  formatBytes(diskFree),
			"total_human": formatBytes(diskTotal),
		}
	})

	// Calculate summary
	summary := HealthCheckSummary{}
	summary.TotalChecks = len(checks)
	for _, check := range checks {
		if check.Status == "passed" {
			summary.Passed++
		} else {
			summary.Failed++
		}
	}

	// Get system resources
	cached := h.monitor.GetCachedSystemResources()
	if cached != nil && cached.Resources != nil {
		summary.SystemHealth.CPUPercent = cached.Resources["cpu_percent"]
		summary.SystemHealth.MemoryPercent = cached.Resources["memory_percent"]
		summary.SystemHealth.DiskPercent = cached.Resources["disk_percent"]
	}
	summary.SystemHealth.DiskFreeBytes = diskFree
	summary.SystemHealth.DiskFreeHuman = formatBytes(diskFree)

	result := &ComprehensiveHealthResponse{
		Status:      map[bool]string{true: "healthy", false: "unhealthy"}[overallPass],
		Timestamp:   time.Now(),
		OverallPass: overallPass,
		Checks:      checks,
		Summary:     summary,
	}

	// Track failures and send alerts if needed
	h.trackFailuresAndAlert(result)

	return result
}

// trackFailuresAndAlert tracks consecutive failures and sends alerts when threshold reached
func (h *MonitoringHandlers) trackFailuresAndAlert(result *ComprehensiveHealthResponse) {
	var failedChecks []string

	for name, check := range result.Checks {
		if check.Status == "failed" {
			count := h.healthCache.failureTracker.RecordFailure(name)
			// Send alert after 3 consecutive failures
			if count >= 3 && h.healthCache.failureTracker.CanAlert(name) {
				failedChecks = append(failedChecks, name)
				h.healthCache.failureTracker.RecordAlert(name)
			}
		} else {
			h.healthCache.failureTracker.RecordSuccess(name)
		}
	}

	if len(failedChecks) > 0 {
		h.sendHealthAlert(failedChecks, result)
	}
}

func checkPathWritableHealth(path string, cfg *config.Config) (bool, string, interface{}) {
	resolved, err := resolveConfigPathHealth(path)
	if err != nil {
		return false, "Path not configured: " + path, nil
	}

	if info, err := os.Stat(resolved); err == nil && info.IsDir() {
		testDir := filepath.Join(resolved, ".health-check-"+randomSuffixHealth(8))
		if err := os.Mkdir(testDir, 0o755); err != nil {
			return false, "Cannot write to directory", map[string]interface{}{
				"path":  resolved,
				"error": err.Error(),
			}
		}
		_ = os.Remove(testDir)

		f, err := os.CreateTemp(resolved, ".health-probe")
		if err != nil {
			return false, "Cannot create test file", map[string]interface{}{
				"path":  resolved,
				"error": err.Error(),
			}
		}
		name := f.Name()
		_ = f.Close()
		_ = os.Remove(name)
		return true, "Path is writable", map[string]interface{}{"path": resolved}
	}

	if err := os.MkdirAll(resolved, 0o755); err != nil {
		return false, "Cannot create directory", map[string]interface{}{
			"path":  resolved,
			"error": err.Error(),
		}
	}

	f, err := os.CreateTemp(resolved, ".health-probe")
	if err != nil {
		return false, "Cannot create test file", map[string]interface{}{
			"path":  resolved,
			"error": err.Error(),
		}
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true, "Path is writable", map[string]interface{}{"path": resolved}
}

func resolveConfigPathHealth(path string) (string, error) {
	return config.ResolveConfigPath(path)
}

func randomSuffixHealth(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return strings.ToUpper(string(b))[:n]
}

func formatBytes(bytes uint64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := uint64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
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
		http.Error(w, "failed to clean up monitoring data", http.StatusInternalServerError)
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
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
		JSONError(w, http.StatusInternalServerError, "failed to set up SMTP")
		return
	}
	if err := mailer.Send([]string{body.To}, "LibreServ SMTP Test", "This is a test email from LibreServ."); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to send email")
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{
		"status": "sent",
		"to":     body.To,
	})
}

// PrometheusMetrics exposes Prometheus metrics for scraping
// GET /metrics
func (h *MonitoringHandlers) PrometheusMetrics(w http.ResponseWriter, r *http.Request) {
	promhttp.Handler().ServeHTTP(w, r)
}
