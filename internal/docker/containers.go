package docker

import (
	"context"
	"encoding/json"
	"fmt"
	
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
)

type ContainerStats struct {
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryUsage uint64  `json:"memory_usage"`
	MemoryLimit uint64  `json:"memory_limit"`
	NetworkRx   uint64  `json:"network_rx"`
	NetworkTx   uint64  `json:"network_tx"`
}

func (c *Client) ListContainersByLabel(label string) ([]types.Container, error) {
	return c.cli.ContainerList(c.ctx, container.ListOptions{
		// Filter by label would go here
		All: true,
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
