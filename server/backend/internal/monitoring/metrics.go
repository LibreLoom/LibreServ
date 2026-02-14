package monitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

// MetricsCollector collects resource usage metrics from Docker containers
type MetricsCollector struct {
	dockerClient *client.Client
}

// NewMetricsCollector creates a new metrics collector
func NewMetricsCollector(dockerClient *client.Client) *MetricsCollector {
	return &MetricsCollector{
		dockerClient: dockerClient,
	}
}

// CollectContainerMetrics collects metrics for a specific container
func (m *MetricsCollector) CollectContainerMetrics(ctx context.Context, containerID string) (*Metrics, error) {
	if m.dockerClient == nil {
		return nil, fmt.Errorf("%w: docker client not available", ErrDockerUnavailable)
	}
	stats, err := m.dockerClient.ContainerStats(ctx, containerID, false)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to get container stats: %v", ErrDockerUnavailable, err)
	}
	defer stats.Body.Close()

	var v container.StatsResponse
	if err := json.NewDecoder(stats.Body).Decode(&v); err != nil {
		return nil, fmt.Errorf("failed to decode stats: %w", err)
	}

	return m.parseStats(&v), nil
}

// CollectAppMetrics collects metrics for all containers belonging to an app
func (m *MetricsCollector) CollectAppMetrics(ctx context.Context, appID string) (*Metrics, error) {
	if m.dockerClient == nil {
		return nil, fmt.Errorf("%w: docker client not available", ErrDockerUnavailable)
	}
	// Find containers belonging to this app by label
	containers, err := m.dockerClient.ContainerList(ctx, container.ListOptions{
		All: false, // Only running containers
	})
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list containers: %v", ErrDockerUnavailable, err)
	}

	aggregated := &Metrics{
		AppID:     appID,
		Timestamp: time.Now(),
	}

	var found bool
	for _, cont := range containers {
		// Check if container belongs to this app
		// Containers are typically named: appid_servicename_1 or appid-servicename-1
		if matchesApp(cont, appID) {
			found = true
			stats, err := m.CollectContainerMetrics(ctx, cont.ID)
			if err != nil {
				continue // Skip failed containers
			}

			// Aggregate metrics
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
	if m.dockerClient == nil {
		return nil, fmt.Errorf("%w: docker client not available", ErrDockerUnavailable)
	}

	containers, err := m.dockerClient.ContainerList(ctx, container.ListOptions{
		All: false, // Only running containers
	})
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list containers: %v", ErrDockerUnavailable, err)
	}

	out := &SystemMetrics{
		Timestamp:         time.Now(),
		RunningContainers: len(containers),
	}

	for _, cont := range containers {
		stats, err := m.CollectContainerMetrics(ctx, cont.ID)
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
func matchesApp(cont types.Container, appID string) bool {
	// Check labels first (preferred method)
	if projectLabel, ok := cont.Labels["com.docker.compose.project"]; ok {
		if projectLabel == appID {
			return true
		}
	}

	// Fallback: check container names
	for _, name := range cont.Names {
		// Remove leading /
		if len(name) > 0 && name[0] == '/' {
			name = name[1:]
		}
		// Check if name starts with appID
		if len(name) >= len(appID) && name[:len(appID)] == appID {
			return true
		}
	}

	return false
}

// parseStats converts Docker stats to our Metrics structure
func (m *MetricsCollector) parseStats(stats *container.StatsResponse) *Metrics {
	metrics := &Metrics{
		Timestamp: time.Now(),
	}

	// Calculate CPU percentage
	cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage) - float64(stats.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(stats.CPUStats.SystemUsage) - float64(stats.PreCPUStats.SystemUsage)

	if systemDelta > 0.0 && cpuDelta > 0.0 {
		cpuCount := float64(stats.CPUStats.OnlineCPUs)
		if cpuCount == 0 {
			cpuCount = float64(len(stats.CPUStats.CPUUsage.PercpuUsage))
		}
		if cpuCount > 0 {
			metrics.CPUPercent = (cpuDelta / systemDelta) * cpuCount * 100.0
		}
	}

	// Memory usage
	metrics.MemoryUsage = stats.MemoryStats.Usage
	metrics.MemoryLimit = stats.MemoryStats.Limit

	// Network I/O (aggregate all interfaces)
	for _, netStats := range stats.Networks {
		metrics.NetworkRx += netStats.RxBytes
		metrics.NetworkTx += netStats.TxBytes
	}

	return metrics
}

// FormatMemory formats bytes to human-readable string
func FormatMemory(bytes uint64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
	)

	switch {
	case bytes >= GB:
		return fmt.Sprintf("%.2f GB", float64(bytes)/float64(GB))
	case bytes >= MB:
		return fmt.Sprintf("%.2f MB", float64(bytes)/float64(MB))
	case bytes >= KB:
		return fmt.Sprintf("%.2f KB", float64(bytes)/float64(KB))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}

// FormatPercent formats a percentage value
func FormatPercent(percent float64) string {
	return fmt.Sprintf("%.2f%%", percent)
}
