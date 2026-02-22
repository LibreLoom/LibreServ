package apps

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

type AppMetricsCache struct {
	mu               sync.RWMutex
	metrics          map[string]*AppMetrics
	statuses         map[string]AppStatus
	lastStarted      map[string]time.Time
	lastStopped      map[string]time.Time
	monitor          *monitoring.Monitor
	metricsCollector *monitoring.MetricsCollector
	logger           *slog.Logger

	stopCh chan struct{}
	wg     sync.WaitGroup
}

type AppMetrics struct {
	CPUPercent   float64
	MemoryUsage  uint64
	MemoryLimit  uint64
	Uptime       int64
	Downtime     int64
	Availability float64
}

func NewAppMetricsCache(monitor *monitoring.Monitor, logger *slog.Logger) *AppMetricsCache {
	var mc *monitoring.MetricsCollector
	if monitor != nil {
		mc = monitor.MetricsCollector()
	}

	return &AppMetricsCache{
		metrics:          make(map[string]*AppMetrics),
		statuses:         make(map[string]AppStatus),
		lastStarted:      make(map[string]time.Time),
		lastStopped:      make(map[string]time.Time),
		monitor:          monitor,
		metricsCollector: mc,
		logger:           logger.With("component", "app-metrics-cache"),
		stopCh:           make(chan struct{}),
	}
}

func (c *AppMetricsCache) Start(ctx context.Context) {
	c.wg.Add(1)
	go c.run(ctx)
	c.logger.Info("app metrics cache started")
}

func (c *AppMetricsCache) Stop() {
	close(c.stopCh)
	c.wg.Wait()
	c.logger.Info("app metrics cache stopped")
}

func (c *AppMetricsCache) run(ctx context.Context) {
	defer c.wg.Done()

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.refresh(ctx)
		}
	}
}

func (c *AppMetricsCache) RefreshNow(ctx context.Context) {
	c.refresh(ctx)
}

func (c *AppMetricsCache) refresh(ctx context.Context) {
	c.mu.RLock()
	appIDs := make([]string, 0, len(c.statuses))
	for id := range c.statuses {
		appIDs = append(appIDs, id)
	}
	c.mu.RUnlock()

	for _, appID := range appIDs {
		c.refreshApp(ctx, appID)
	}
}

func (c *AppMetricsCache) refreshApp(ctx context.Context, appID string) {
	c.mu.RLock()
	status := c.statuses[appID]
	lastStarted := c.lastStarted[appID]
	lastStopped := c.lastStopped[appID]
	c.mu.RUnlock()

	metrics := &AppMetrics{}

	if c.metricsCollector != nil && status == StatusRunning {
		dockerMetrics, err := c.metricsCollector.CollectAppMetrics(ctx, appID)
		if err != nil {
			c.logger.Debug("failed to collect metrics", "appID", appID, "error", err)
		} else {
			metrics.CPUPercent = dockerMetrics.CPUPercent
			metrics.MemoryUsage = dockerMetrics.MemoryUsage
			metrics.MemoryLimit = dockerMetrics.MemoryLimit
		}
	}

	now := time.Now()
	if status == StatusRunning {
		if !lastStarted.IsZero() {
			metrics.Uptime = int64(now.Sub(lastStarted).Seconds())
		} else {
			metrics.Uptime = 0
		}
	}
	if status == StatusStopped && !lastStopped.IsZero() {
		metrics.Downtime = int64(now.Sub(lastStopped).Seconds())
	}

	if c.monitor != nil {
		metrics.Availability = c.monitor.CalculateAvailability(ctx, appID)
	}

	c.mu.Lock()
	c.metrics[appID] = metrics
	c.mu.Unlock()
}

func (c *AppMetricsCache) GetMetrics(appID string) *AppMetrics {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if m, ok := c.metrics[appID]; ok {
		return m
	}
	return &AppMetrics{}
}

func (c *AppMetricsCache) UpdateStatus(appID string, status AppStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()

	prevStatus := c.statuses[appID]
	now := time.Now()

	if status == StatusRunning && prevStatus != StatusRunning {
		c.lastStarted[appID] = now
	}

	if status == StatusStopped && prevStatus != StatusStopped {
		c.lastStopped[appID] = now
	}

	c.statuses[appID] = status
}

func (c *AppMetricsCache) RemoveApp(appID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.metrics, appID)
	delete(c.statuses, appID)
	delete(c.lastStarted, appID)
	delete(c.lastStopped, appID)
}
