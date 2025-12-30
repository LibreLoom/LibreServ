package docker

import (
	"encoding/json"
	"errors"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
)

// ContainerStats summarizes container resource usage.
type ContainerStats struct {
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryUsage uint64  `json:"memory_usage"`
	MemoryLimit uint64  `json:"memory_limit"`
	NetworkRx   uint64  `json:"network_rx"`
	NetworkTx   uint64  `json:"network_tx"`
}

// ListContainersByLabel returns containers matching a label filter.
func (c *Client) ListContainersByLabel(label string) ([]types.Container, error) {
	if c == nil || c.cli == nil {
		return nil, errors.New("docker client not initialized")
	}
	args := filters.NewArgs()
	args.Add("label", label)

	return c.cli.ContainerList(c.ctx, container.ListOptions{
		All:     true,
		Filters: args,
	})
}

// GetContainerStats retrieves real-time stats
// Note: This is a simplified implementation. Real stats calculation from the stream is complex.
func (c *Client) GetContainerStats(containerID string) (*ContainerStats, error) {
	stats, err := c.cli.ContainerStats(c.ctx, containerID, false)
	if err != nil {
		return nil, err
	}
	defer stats.Body.Close()

	var v types.StatsJSON
	if err := json.NewDecoder(stats.Body).Decode(&v); err != nil {
		return nil, err
	}

	// Calculate CPU Percent (simplified)
	cpuDelta := float64(v.CPUStats.CPUUsage.TotalUsage) - float64(v.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(v.CPUStats.SystemUsage) - float64(v.PreCPUStats.SystemUsage)

	cpuPercent := 0.0
	if systemDelta > 0.0 && cpuDelta > 0.0 {
		cpuPercent = (cpuDelta / systemDelta) * float64(len(v.CPUStats.CPUUsage.PercpuUsage)) * 100.0
	}

	return &ContainerStats{
		CPUPercent:  cpuPercent,
		MemoryUsage: v.MemoryStats.Usage,
		MemoryLimit: v.MemoryStats.Limit,
		// Network stats need more parsing from v.Networks
	}, nil
}
