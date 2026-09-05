package monitoring

import (
	"context"
	"fmt"
	"log"
	"runtime"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	rt "gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

// Monitor manages health checks and metrics collection for all apps
type Monitor struct {
	db               *database.DB
	runtime          rt.ContainerRuntime
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
func NewMonitor(db *database.DB, rt rt.ContainerRuntime, dataPath string) *Monitor {
	return &Monitor{
		db:               db,
		runtime:          rt,
		metricsCollector: NewMetricsCollector(rt),
		hostCollector:    NewHostMetricsCollector(),
		checkers:         make(map[string]*HealthChecker),
		metricsInterval:  30 * time.Second,
		dataPath:         dataPath,
		stopCh:           make(chan struct{}),
	}
}

// Start begins background monitoring tasks
func (m *Monitor) Start() {
	if m.runtime == nil {
		return
	}
	m.wg.Add(1)
	go m.collectMetricsLoop()
}

// Stophalts all monitoring activities
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
		if m.runtime == nil {
			return fmt.Errorf("%w: container checks require runtime", ErrRuntimeUnavailable)
		}
		checks = append(checks, NewContainerCheck(*config.Container, m.runtime))
	}

	// If no specific checks configured, add a default container check
	if len(checks) == 0 {
		if m.runtime == nil {
			return fmt.Errorf("%w: no checks configured and runtime is unavailable", ErrRuntimeUnavailable)
		}
		checks = append(checks, NewContainerCheck(ContainerCheckConfig{
			ContainerName: appID,
		}, m.runtime))
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
