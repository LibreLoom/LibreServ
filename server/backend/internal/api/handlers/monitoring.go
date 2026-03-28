package handlers

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"runtime"
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

// MonitoringHandlers handles monitoring-related API endpoints
type MonitoringHandlers struct {
	monitor      *monitoring.Monitor
	db           *database.DB
	docker       *docker.Client
	mailer       func() (*email.Sender, error)
	metricsCache *apps.AppMetricsCache

	netMu            sync.Mutex
	lastNetBytes     uint64
	lastNetAt        time.Time
	lastHostNetBytes uint64
	lastHostNetAt    time.Time

	cpuMu        sync.Mutex
	lastCPUIdle  uint64
	lastCPUTotal uint64
	cpuPrimed    bool
}

// NewMonitoringHandlers creates new monitoring handlers
func NewMonitoringHandlers(monitor *monitoring.Monitor, db *database.DB, dockerClient *docker.Client, metricsCache *apps.AppMetricsCache) *MonitoringHandlers {
	return &MonitoringHandlers{
		monitor:      monitor,
		db:           db,
		docker:       dockerClient,
		mailer:       email.NewSender,
		metricsCache: metricsCache,
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

	systemMetrics := &monitoring.SystemMetrics{
		Timestamp: time.Now(),
	}
	if h.monitor != nil {
		if metrics, err := h.monitor.GetSystemMetrics(r.Context()); err == nil && metrics != nil {
			systemMetrics = metrics
		}
	}

	diskTotal, diskFree := getDiskUsage(config.Get().Apps.DataPath)
	cpuResource := clamp01(systemMetrics.CPUPercent / (float64(runtime.NumCPU()) * 100.0))
	ramResource := normalizeUsage(systemMetrics.MemoryUsage, systemMetrics.MemoryLimit)
	hostCPU := h.hostCPUUsage()
	if hostCPU == 0 {
		hostCPU = hostCPULoad()
	}
	hostRAM := hostMemoryUsage()
	if cpuResource == 0 {
		cpuResource = hostCPU
	}
	if ramResource == 0 || hostRAM > ramResource {
		ramResource = hostRAM
	}
	resources := map[string]float64{
		"cpu":  cpuResource,
		"ram":  ramResource,
		"disk": normalizeUsage(diskTotal-diskFree, diskTotal),
		"net":  0,
	}
	now := time.Now()
	containerNet := h.networkLoad(systemMetrics.NetworkRx+systemMetrics.NetworkTx, now)
	hostNet := h.hostNetworkLoad(now)
	resources["net"] = maxFloat(containerNet, hostNet)

	response := map[string]interface{}{
		"status":    "healthy",
		"timestamp": time.Now(),
		"checks": map[string]interface{}{
			"api":      "healthy",
			"database": dbStatus,
			"docker":   dockerStatus,
			"smtp":     smtpStatus,
		},
		"resources": resources,
		"system_metrics": map[string]interface{}{
			"running_containers": systemMetrics.RunningContainers,
			"cpu_percent":        systemMetrics.CPUPercent,
			"memory_usage":       systemMetrics.MemoryUsage,
			"memory_limit":       systemMetrics.MemoryLimit,
			"network_rx":         systemMetrics.NetworkRx,
			"network_tx":         systemMetrics.NetworkTx,
			"disk_total":         diskTotal,
			"disk_free":          diskFree,
			"host_cpu_load":      hostCPU,
			"host_memory_usage":  hostRAM,
			"container_net_load": containerNet,
			"host_net_load":      hostNet,
		},
	}

	JSON(w, http.StatusOK, response)
}

func normalizeUsage(usage, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return clamp01(float64(usage) / float64(total))
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func getDiskUsage(path string) (total, free uint64) {
	tryPaths := []string{path}
	if path != "/" {
		tryPaths = append(tryPaths, "/")
	}

	for _, p := range tryPaths {
		if p == "" {
			continue
		}
		var stat syscall.Statfs_t
		if err := syscall.Statfs(p, &stat); err != nil {
			continue
		}
		total = stat.Blocks * uint64(stat.Bsize)
		free = stat.Bavail * uint64(stat.Bsize)
		return total, free
	}

	return total, free
}

func (h *MonitoringHandlers) networkLoad(totalBytes uint64, now time.Time) float64 {
	const baselineBytesPerSecond = 1024 * 1024 // 1 MB/s ~= high network utilization for stress index

	h.netMu.Lock()
	defer h.netMu.Unlock()

	if h.lastNetAt.IsZero() {
		h.lastNetAt = now
		h.lastNetBytes = totalBytes
		return 0
	}

	elapsed := now.Sub(h.lastNetAt).Seconds()
	if elapsed <= 0 {
		return 0
	}

	var delta uint64
	if totalBytes >= h.lastNetBytes {
		delta = totalBytes - h.lastNetBytes
	}

	h.lastNetAt = now
	h.lastNetBytes = totalBytes

	return clamp01((float64(delta) / elapsed) / baselineBytesPerSecond)
}

func (h *MonitoringHandlers) hostNetworkLoad(now time.Time) float64 {
	const baselineBytesPerSecond = 256 * 1024 // 256 KB/s ~= high host network utilization for stress index

	totalBytes, ok := readProcNetDevTotal()
	if !ok {
		return 0
	}

	h.netMu.Lock()
	defer h.netMu.Unlock()

	if h.lastHostNetAt.IsZero() {
		h.lastHostNetAt = now
		h.lastHostNetBytes = totalBytes
		return 0
	}

	elapsed := now.Sub(h.lastHostNetAt).Seconds()
	if elapsed <= 0 {
		return 0
	}

	var delta uint64
	if totalBytes >= h.lastHostNetBytes {
		delta = totalBytes - h.lastHostNetBytes
	}

	h.lastHostNetAt = now
	h.lastHostNetBytes = totalBytes

	return clamp01((float64(delta) / elapsed) / baselineBytesPerSecond)
}

func readProcNetDevTotal() (total uint64, ok bool) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		if lineNo <= 2 {
			continue
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.Split(line, ":")
		if len(parts) != 2 {
			continue
		}
		iface := strings.TrimSpace(parts[0])
		if iface == "lo" {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) < 16 {
			continue
		}
		rx, err1 := strconv.ParseUint(fields[0], 10, 64)
		tx, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		total += rx + tx
	}

	return total, true
}

func (h *MonitoringHandlers) hostCPUUsage() float64 {
	total, idle, ok := readProcStatCPU()
	if !ok {
		return 0
	}

	h.cpuMu.Lock()
	defer h.cpuMu.Unlock()

	if !h.cpuPrimed {
		h.lastCPUTotal = total
		h.lastCPUIdle = idle
		h.cpuPrimed = true
		return 0
	}

	totalDelta := total - h.lastCPUTotal
	idleDelta := idle - h.lastCPUIdle
	h.lastCPUTotal = total
	h.lastCPUIdle = idle

	if totalDelta == 0 || idleDelta > totalDelta {
		return 0
	}

	activeDelta := totalDelta - idleDelta
	return clamp01(float64(activeDelta) / float64(totalDelta))
}

func readProcStatCPU() (total uint64, idle uint64, ok bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		return 0, 0, false
	}
	fields := strings.Fields(scanner.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, false
	}

	values := make([]uint64, 0, len(fields)-1)
	for _, raw := range fields[1:] {
		v, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		values = append(values, v)
		total += v
	}

	// idle + iowait
	idle = values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	return total, idle, true
}

func hostCPULoad() float64 {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	parts := strings.Fields(string(data))
	if len(parts) == 0 {
		return 0
	}
	load1, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return 0
	}
	cpus := float64(runtime.NumCPU())
	if cpus <= 0 {
		return 0
	}
	return clamp01(load1 / cpus)
}

func hostMemoryUsage() float64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()

	var totalKB uint64
	var availKB uint64

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			v, err := strconv.ParseUint(fields[1], 10, 64)
			if err == nil {
				totalKB = v
			}
		case "MemAvailable:":
			v, err := strconv.ParseUint(fields[1], 10, 64)
			if err == nil {
				availKB = v
			}
		}
	}

	if totalKB == 0 {
		return 0
	}
	if availKB > totalKB {
		availKB = totalKB
	}
	usedKB := totalKB - availKB
	return clamp01(float64(usedKB) / float64(totalKB))
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
