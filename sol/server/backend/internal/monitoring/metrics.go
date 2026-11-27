package monitoring

import (
	"context"
	"fmt"
	"time"

	rt "gt.plainskill.net/LibreLoom/Sol/internal/runtime"
)

// MetricsCollector collects resource usage metrics from containers
type MetricsCollector struct {
	runtime rt.ContainerRuntime
}

// NewMetricsCollector creates a new metrics collector
func NewMetricsCollector(rts rt.ContainerRuntime) *MetricsCollector {
	return &MetricsCollector{
		runtime: rts,
	}
}

// CollectContainerMetrics collects metrics for a specific container
func (m *MetricsCollector) CollectContainerMetrics(ctx context.Context, containerID string) (*Metrics, error) {
	if m.runtime == nil {
		return nil, fmt.Errorf("%w: runtime not available", ErrRuntimeUnavailable)
	}
	stats, err := m.runtime.GetContainerStats(ctx, containerID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to get container stats: %v", ErrRuntimeUnavailable, err)
	}

	return m.parseStats(stats), nil
}

// CollectAppMetrics collects metrics for all containers belonging to an app
func (m *MetricsCollector) CollectAppMetrics(ctx context.Context, appID string) (*Metrics, error) {
	if m.runtime == nil {
		return nil, fmt.Errorf("%w: runtime not available", ErrRuntimeUnavailable)
	}
	containers, err := m.runtime.ListContainersAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list containers: %v", ErrRuntimeUnavailable, err)
	}

	aggregated := &Metrics{
		AppID:     appID,
		Timestamp: time.Now(),
	}

	var found bool
	for _, cont := range containers {
		if matchesApp(cont, appID) {
			found = true
			stats, err := m.runtime.GetContainerStats(ctx, cont.ID)
			if err != nil {
				continue
			}
			aggregated.addStats(stats)
		}
	}

	if !found {
		return nil, fmt.Errorf("%w for app: %s", ErrNoContainers, appID)
	}

	return aggregated, nil
}

// CollectSystemMetrics collects aggregate metrics across all running containers.
func (m *MetricsCollector) CollectSystemMetrics(ctx context.Context) (*SystemMetrics, error) {
	if m.runtime == nil {
		return nil, fmt.Errorf("%w: runtime not available", ErrRuntimeUnavailable)
	}

	containers, err := m.runtime.ListContainersAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list containers: %v", ErrRuntimeUnavailable, err)
	}

	out := &SystemMetrics{
		Timestamp:         time.Now(),
		RunningContainers: len(containers),
	}

	for _, cont := range containers {
		stats, err := m.runtime.GetContainerStats(ctx, cont.ID)
		if err != nil {
			continue
		}
		out.addStats(stats)
	}

	return out, nil
}

// collectPeriodicMetrics uses one runtime snapshot for app history and the
// system dashboard. A container can match more than one app, but its stats
// are sampled only once per tick.
func (m *MetricsCollector) collectPeriodicMetrics(ctx context.Context, appIDs []string) (*SystemMetrics, []*Metrics, error) {
	if m.runtime == nil {
		return nil, nil, fmt.Errorf("%w: runtime not available", ErrRuntimeUnavailable)
	}
	containers, err := m.runtime.ListContainersAll(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: failed to list containers: %v", ErrRuntimeUnavailable, err)
	}

	now := time.Now()
	system := &SystemMetrics{Timestamp: now, RunningContainers: len(containers)}
	apps := make([]*Metrics, len(appIDs))
	for _, cont := range containers {
		stats, err := m.runtime.GetContainerStats(ctx, cont.ID)
		if err == nil {
			system.addStats(stats)
		}
		for i, appID := range appIDs {
			if !matchesApp(cont, appID) {
				continue
			}
			if apps[i] == nil {
				apps[i] = &Metrics{AppID: appID, Timestamp: now}
			}
			if err == nil {
				apps[i].addStats(stats)
			}
		}
	}
	return system, apps, nil
}

func (m *Metrics) addStats(stats *rt.ContainerStats) {
	m.CPUPercent += stats.CPUPercent
	m.MemoryUsage += stats.MemoryUsage
	m.MemoryLimit += stats.MemoryLimit
	m.NetworkRx += stats.NetworkRx
	m.NetworkTx += stats.NetworkTx
}

func (m *SystemMetrics) addStats(stats *rt.ContainerStats) {
	m.CPUPercent += stats.CPUPercent
	m.MemoryUsage += stats.MemoryUsage
	m.MemoryLimit += stats.MemoryLimit
	m.NetworkRx += stats.NetworkRx
	m.NetworkTx += stats.NetworkTx
}

// matchesApp checks if a container belongs to the given app
func matchesApp(cont rt.ContainerInfo, appID string) bool {
	if projectLabel, ok := cont.Labels["com.docker.compose.project"]; ok {
		if projectLabel == appID {
			return true
		}
	}

	for _, name := range cont.Names {
		if len(name) > 0 && name[0] == '/' {
			name = name[1:]
		}
		if len(name) >= len(appID) && name[:len(appID)] == appID {
			return true
		}
	}

	return false
}

// parseStats converts runtime.ContainerStats to our Metrics structure
func (m *MetricsCollector) parseStats(stats *rt.ContainerStats) *Metrics {
	return &Metrics{
		Timestamp:   time.Now(),
		CPUPercent:  stats.CPUPercent,
		MemoryUsage: stats.MemoryUsage,
		MemoryLimit: stats.MemoryLimit,
		NetworkRx:   stats.NetworkRx,
		NetworkTx:   stats.NetworkTx,
	}
}
