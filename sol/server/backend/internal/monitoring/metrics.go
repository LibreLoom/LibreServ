package monitoring

import (
	"context"
	"fmt"
	"time"

	rt "gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
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
			aggregated.CPUPercent += stats.CPUPercent
			aggregated.MemoryUsage += stats.MemoryUsage
			aggregated.MemoryLimit += stats.MemoryLimit
			aggregated.NetworkRx += stats.NetworkRx
			aggregated.NetworkTx += stats.NetworkTx
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
		out.CPUPercent += stats.CPUPercent
		out.MemoryUsage += stats.MemoryUsage
		out.MemoryLimit += stats.MemoryLimit
		out.NetworkRx += stats.NetworkRx
		out.NetworkTx += stats.NetworkTx
	}

	return out, nil
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
