package monitoring

import (
	"context"
	"fmt"
	"log"
	"runtime"
	"sync"
	"time"

	"github.com/docker/docker/client"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// Monitor manages health checks and metrics collection for all apps
type Monitor struct {
	db               *database.DB
	dockerClient     *client.Client
	metricsCollector *MetricsCollector
	hostCollector    *HostMetricsCollector

	// Health check state
	checkers   map[string]*HealthChecker
	checkersMu sync.RWMutex

	// System resources cache
	systemCacheMu sync.RWMutex
	systemCache   *CachedSystemResources

	// Configuration
	metricsInterval time.Duration
	dataPath        string

	// Control
	stopCh chan struct{}
	wg     sync.WaitGroup

	// Repair callback (set by apps.Manager)
	RepairCallback func(appID string)
}

// HealthChecker manages health checks for a single app
type HealthChecker struct {
	AppID            string
	Checks           []Check
	Interval         time.Duration
	Timeout          time.Duration
	FailureThreshold int
	SuccessThreshold int

	// State
	consecutiveFailures  int
	consecutiveSuccesses int
	currentStatus        HealthStatus
	lastCheck            *CheckResult

	// Control
	stopCh chan struct{}
	mu     sync.RWMutex
}

// NewMonitor creates a new monitoring instance
func NewMonitor(db *database.DB, dockerClient *client.Client, dataPath string) *Monitor {
	return &Monitor{
		db:               db,
		dockerClient:     dockerClient,
		metricsCollector: NewMetricsCollector(dockerClient),
		hostCollector:    NewHostMetricsCollector(),
		checkers:         make(map[string]*HealthChecker),
		metricsInterval:  30 * time.Second,
		dataPath:         dataPath,
		stopCh:           make(chan struct{}),
	}
}

// Start begins background monitoring tasks
func (m *Monitor) Start() {
	if m.dockerClient == nil {
		// Docker-backed metrics are disabled; health checks may still run for HTTP/TCP.
		return
	}
	m.wg.Add(1)
	go m.collectMetricsLoop()
}

// Stop halts all monitoring activities
func (m *Monitor) Stop() {
	close(m.stopCh)

	// Stop all health checkers
	m.checkersMu.Lock()
	for _, checker := range m.checkers {
		checker.Stop()
	}
	m.checkersMu.Unlock()

	m.wg.Wait()
}

// RegisterApp registers an app for health monitoring
func (m *Monitor) RegisterApp(appID string, config HealthCheckConfig) error {
	m.checkersMu.Lock()
	defer m.checkersMu.Unlock()

	// Stop existing checker if any
	if existing, ok := m.checkers[appID]; ok {
		existing.Stop()
	}

	// Build checks based on config
	var checks []Check

	if config.HTTP != nil {
		checks = append(checks, NewHTTPCheck(*config.HTTP, config.Timeout))
	}

	if config.TCP != nil {
		checks = append(checks, NewTCPCheck(*config.TCP, config.Timeout))
	}

	if config.Container != nil {
		if m.dockerClient == nil {
			return fmt.Errorf("%w: container checks require docker", ErrDockerUnavailable)
		}
		checks = append(checks, NewContainerCheck(*config.Container, m.dockerClient))
	}

	// If no specific checks configured, add a default container check
	if len(checks) == 0 {
		if m.dockerClient == nil {
			return fmt.Errorf("%w: no checks configured and docker is unavailable", ErrDockerUnavailable)
		}
		checks = append(checks, NewContainerCheck(ContainerCheckConfig{
			ContainerName: appID,
		}, m.dockerClient))
	}

	// Set defaults
	interval := config.Interval
	if interval == 0 {
		interval = 30 * time.Second
	}

	timeout := config.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}

	failureThreshold := config.FailureThreshold
	if failureThreshold == 0 {
		failureThreshold = 3
	}

	successThreshold := config.SuccessThreshold
	if successThreshold == 0 {
		successThreshold = 1
	}

	checker := &HealthChecker{
		AppID:            appID,
		Checks:           checks,
		Interval:         interval,
		Timeout:          timeout,
		FailureThreshold: failureThreshold,
		SuccessThreshold: successThreshold,
		currentStatus:    HealthStatusUnknown,
		stopCh:           make(chan struct{}),
	}

	m.checkers[appID] = checker

	// Start the checker
	go m.runHealthChecker(checker)

	return nil
}

// UnregisterApp removes an app from health monitoring
func (m *Monitor) UnregisterApp(appID string) {
	m.checkersMu.Lock()
	defer m.checkersMu.Unlock()

	if checker, ok := m.checkers[appID]; ok {
		checker.Stop()
		delete(m.checkers, appID)
	}
}

// GetAppHealth returns the current health status for an app
func (m *Monitor) GetAppHealth(ctx context.Context, appID string) (*AppHealth, error) {
	m.checkersMu.RLock()
	checker, ok := m.checkers[appID]
	m.checkersMu.RUnlock()

	health := &AppHealth{
		AppID:  appID,
		Status: HealthStatusUnknown,
	}

	if ok {
		checker.mu.RLock()
		health.Status = checker.currentStatus
		if checker.lastCheck != nil {
			health.LastCheck = &checker.lastCheck.Timestamp
			health.Message = checker.lastCheck.Message
		}
		checker.mu.RUnlock()
	}

	// Get recent checks from database
	checks, err := m.getRecentChecks(ctx, appID, 10)
	if err == nil {
		health.RecentChecks = checks
	}

	// Get current metrics
	metrics, err := m.metricsCollector.CollectAppMetrics(ctx, appID)
	if err == nil {
		health.CurrentMetrics = metrics
	}

	return health, nil
}

// GetAppMetrics returns current metrics for an app
func (m *Monitor) GetAppMetrics(ctx context.Context, appID string) (*Metrics, error) {
	return m.metricsCollector.CollectAppMetrics(ctx, appID)
}

// GetSystemMetrics returns aggregate metrics across all running containers.
func (m *Monitor) GetSystemMetrics(ctx context.Context) (*SystemMetrics, error) {
	return m.metricsCollector.CollectSystemMetrics(ctx)
}

// CalculateAvailability calculates the availability percentage for an app based on recent health checks
// Takes into account missing checks due to downtime (time since last check)
func (m *Monitor) CalculateAvailability(ctx context.Context, appID string) float64 {
	// Check if the app is currently stopped
	var appStatus string
	err := m.db.QueryRow(`SELECT status FROM apps WHERE id = ?`, appID).Scan(&appStatus)
	if err != nil {
		return 0
	}

	// Get health check counts
	checks, err := m.getRecentChecks(ctx, appID, 100)
	if err != nil || len(checks) == 0 {
		// No checks at all - if stopped, 0% availability
		if appStatus == "stopped" {
			return 0
		}
		return 0
	}

	healthy := 0
	for _, check := range checks {
		if check.Status == HealthStatusHealthy {
			healthy++
		}
	}

	// For stopped apps, calculate availability including downtime
	if appStatus == "stopped" {
		// Get the timestamp of the last health check directly from DB
		var lastCheckTime time.Time
		err = m.db.QueryRow(`
			SELECT checked_at FROM health_checks 
			WHERE app_id = ? 
			ORDER BY checked_at DESC LIMIT 1
		`, appID).Scan(&lastCheckTime)

		if err == nil {
			timeSinceLastCheck := time.Since(lastCheckTime)

			// Calculate how many checks would have occurred during downtime
			// Assuming 30 second check interval
			missingChecks := int(timeSinceLastCheck.Seconds() / 30)
			if missingChecks > 100 {
				missingChecks = 100
			}

			// The total "slots" we're measuring: actual checks + missing checks (capped at 100)
			totalSlots := len(checks) + missingChecks
			if totalSlots > 100 {
				totalSlots = 100
			}

			// Only healthy checks from when app was running count
			return float64(healthy) / float64(totalSlots) * 100
		}

		// Fallback: if we can't get the time, just use the check count ratio
		return float64(healthy) / float64(100) * 100
	}

	// Normal case for running apps: missing checks count as unhealthy
	totalExpected := 100
	if len(checks) < totalExpected {
		return float64(healthy) / float64(totalExpected) * 100
	}

	return float64(healthy) / float64(len(checks)) * 100
}

// GetAppHealthStatus returns the current health status for an app
func (m *Monitor) GetAppHealthStatus(ctx context.Context, appID string) HealthStatus {
	health, err := m.GetAppHealth(ctx, appID)
	if err != nil {
		return HealthStatusUnknown
	}
	return health.Status
}

// MetricsCollector returns the underlying metrics collector for direct access
func (m *Monitor) MetricsCollector() *MetricsCollector {
	return m.metricsCollector
}

// GetMetricsHistory returns historical metrics for an app
func (m *Monitor) GetMetricsHistory(ctx context.Context, appID string, since time.Time, limit int) ([]Metrics, error) {
	query := `
		SELECT app_id, timestamp, cpu_percent, memory_usage, memory_limit, network_rx, network_tx
		FROM metrics
		WHERE app_id = ? AND timestamp >= ?
		ORDER BY timestamp DESC
		LIMIT ?
	`

	rows, err := m.db.Query(query, appID, since, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query metrics: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			log.Printf("failed to close rows: %v", cerr)
		}
	}()

	var metrics []Metrics
	for rows.Next() {
		var metric Metrics
		err := rows.Scan(
			&metric.AppID,
			&metric.Timestamp,
			&metric.CPUPercent,
			&metric.MemoryUsage,
			&metric.MemoryLimit,
			&metric.NetworkRx,
			&metric.NetworkTx,
		)
		if err != nil {
			continue
		}
		metrics = append(metrics, metric)
	}

	return metrics, nil
}

// runHealthChecker runs the health check loop for a single app
func (m *Monitor) runHealthChecker(checker *HealthChecker) {
	ticker := time.NewTicker(checker.Interval)
	defer ticker.Stop()

	// Run immediately on start
	m.runCheck(checker)

	for {
		select {
		case <-ticker.C:
			m.runCheck(checker)
		case <-checker.stopCh:
			return
		case <-m.stopCh:
			return
		}
	}
}

// runCheck executes a health check and updates status
func (m *Monitor) runCheck(checker *HealthChecker) {
	ctx, cancel := context.WithTimeout(context.Background(), checker.Timeout)
	defer cancel()

	// Run all checks
	var composite *CompositeCheck
	if len(checker.Checks) > 1 {
		composite = NewCompositeCheck(checker.Checks...)
	}

	var result CheckResult
	if composite != nil {
		result = composite.Run(ctx)
	} else if len(checker.Checks) > 0 {
		result = checker.Checks[0].Run(ctx)
	} else {
		result = CheckResult{
			Status:    HealthStatusUnknown,
			Message:   "No checks configured",
			Timestamp: time.Now(),
		}
	}

	// Update checker state
	checker.mu.Lock()
	checker.lastCheck = &result

	switch result.Status {
	case HealthStatusHealthy:
		checker.consecutiveSuccesses++
		checker.consecutiveFailures = 0
		if checker.consecutiveSuccesses >= checker.SuccessThreshold {
			checker.currentStatus = HealthStatusHealthy
		}
	case HealthStatusUnhealthy:
		checker.consecutiveFailures++
		checker.consecutiveSuccesses = 0
		if checker.consecutiveFailures >= checker.FailureThreshold {
			checker.currentStatus = HealthStatusUnhealthy
			// Trigger auto-repair
			m.triggerRepair(checker.AppID)
		}
	case HealthStatusDegraded:
		checker.currentStatus = HealthStatusDegraded
	default:
		if checker.currentStatus == HealthStatusUnknown {
			checker.currentStatus = result.Status
		}
	}

	currentStatus := checker.currentStatus
	checker.mu.Unlock()

	// Save to database
	m.saveHealthCheck(checker.AppID, &result)

	// Update app's health status in database
	m.updateAppHealth(checker.AppID, currentStatus)
}

// triggerRepair calls the repair callback if set
func (m *Monitor) triggerRepair(appID string) {
	if m.RepairCallback != nil {
		m.RepairCallback(appID)
	}
}

// saveHealthCheck saves a health check result to the database
func (m *Monitor) saveHealthCheck(appID string, result *CheckResult) {
	query := `
		INSERT INTO health_checks (app_id, check_type, status, message, checked_at)
		VALUES (?, ?, ?, ?, ?)
	`
	_, err := m.db.Exec(query, appID, result.CheckType, string(result.Status), result.Message, result.Timestamp)
	if err != nil {
		log.Printf("Failed to save health check for %s: %v", appID, err)
	}
}

// updateAppHealth updates the app's health status in the apps table
func (m *Monitor) updateAppHealth(appID string, status HealthStatus) {
	query := `UPDATE apps SET health_status = ?, updated_at = ? WHERE id = ?`
	_, err := m.db.Exec(query, string(status), time.Now(), appID)
	if err != nil {
		log.Printf("Failed to update app health for %s: %v", appID, err)
	}
}

// getRecentChecks retrieves recent health check results from the database
func (m *Monitor) getRecentChecks(ctx context.Context, appID string, limit int) ([]CheckResult, error) {
	query := `
		SELECT check_type, status, message, checked_at
		FROM health_checks
		WHERE app_id = ?
		ORDER BY checked_at DESC
		LIMIT ?
	`

	rows, err := m.db.Query(query, appID, limit)
	if err != nil {
		return nil, err
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			log.Printf("failed to close rows: %v", cerr)
		}
	}()

	var results []CheckResult
	for rows.Next() {
		var r CheckResult
		var status string
		err := rows.Scan(&r.CheckType, &status, &r.Message, &r.Timestamp)
		if err != nil {
			continue
		}
		r.Status = HealthStatus(status)
		results = append(results, r)
	}

	return results, nil
}

// collectMetricsLoop periodically collects metrics for all apps
func (m *Monitor) collectMetricsLoop() {
	defer m.wg.Done()

	ticker := time.NewTicker(m.metricsInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.collectAllMetrics()
			m.collectAndCacheSystemResources()
		case <-m.stopCh:
			return
		}
	}
}

// collectAllMetrics collects metrics for all registered apps
func (m *Monitor) collectAllMetrics() {
	m.checkersMu.RLock()
	appIDs := make([]string, 0, len(m.checkers))
	for appID := range m.checkers {
		appIDs = append(appIDs, appID)
	}
	m.checkersMu.RUnlock()

	ctx := context.Background()

	for _, appID := range appIDs {
		metrics, err := m.metricsCollector.CollectAppMetrics(ctx, appID)
		if err != nil {
			log.Printf("Failed to collect metrics for %s: %v", appID, err)
			continue
		}

		// Save to database
		m.saveMetrics(metrics)
	}
}

// saveMetrics saves metrics to the database
func (m *Monitor) saveMetrics(metrics *Metrics) {
	query := `
		INSERT INTO metrics (app_id, timestamp, cpu_percent, memory_usage, memory_limit, network_rx, network_tx)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`
	_, err := m.db.Exec(query,
		metrics.AppID,
		metrics.Timestamp,
		metrics.CPUPercent,
		metrics.MemoryUsage,
		metrics.MemoryLimit,
		metrics.NetworkRx,
		metrics.NetworkTx,
	)
	if err != nil {
		log.Printf("Failed to save metrics for %s: %v", metrics.AppID, err)
	}
}

func (m *Monitor) collectAndCacheSystemResources() {
	ctx := context.Background()

	systemMetrics, err := m.metricsCollector.CollectSystemMetrics(ctx)
	if err != nil {
		systemMetrics = &SystemMetrics{Timestamp: time.Now()}
	}

	diskTotal, diskFree := m.hostCollector.DiskUsage(m.dataPath)
	cpuResource := clamp01(systemMetrics.CPUPercent / (float64(runtime.NumCPU()) * 100.0))
	ramResource := normalizeUsage(systemMetrics.MemoryUsage, systemMetrics.MemoryLimit)
	hostCPU := m.hostCollector.HostCPU()
	if hostCPU == 0 {
		hostCPU = m.hostCollector.HostCPULoad()
	}
	hostRAM := m.hostCollector.HostMemory()
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
	containerNet := m.hostCollector.NetworkLoad(systemMetrics.NetworkRx+systemMetrics.NetworkTx, now)
	hostNet := m.hostCollector.HostNetworkLoad(now)
	resources["net"] = maxFloat(containerNet, hostNet)

	cached := &CachedSystemResources{
		Timestamp: now,
		Resources: resources,
		SystemMetrics: map[string]interface{}{
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
		RunningContainers: systemMetrics.RunningContainers,
	}

	m.systemCacheMu.Lock()
	m.systemCache = cached
	m.systemCacheMu.Unlock()
}

func (m *Monitor) GetCachedSystemResources() *CachedSystemResources {
	m.systemCacheMu.RLock()
	defer m.systemCacheMu.RUnlock()
	return m.systemCache
}

func (m *Monitor) CollectAndCacheSystemResourcesSync() {
	m.collectAndCacheSystemResources()
}

// CleanupOldData removes old health checks and metrics
func (m *Monitor) CleanupOldData(retention time.Duration) error {
	cutoff := time.Now().Add(-retention)

	// Delete old health checks
	_, err := m.db.Exec("DELETE FROM health_checks WHERE checked_at < ?", cutoff)
	if err != nil {
		return fmt.Errorf("failed to cleanup health checks: %w", err)
	}

	// Delete old metrics
	_, err = m.db.Exec("DELETE FROM metrics WHERE timestamp < ?", cutoff)
	if err != nil {
		return fmt.Errorf("failed to cleanup metrics: %w", err)
	}

	return nil
}

// Stop stops the health checker
func (hc *HealthChecker) Stop() {
	close(hc.stopCh)
}

// GetStatus returns the current status
func (hc *HealthChecker) GetStatus() HealthStatus {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	return hc.currentStatus
}

// GetLastCheck returns the last check result
func (hc *HealthChecker) GetLastCheck() *CheckResult {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	if hc.lastCheck == nil {
		return nil
	}
	// Return a copy
	copy := *hc.lastCheck
	return &copy
}
