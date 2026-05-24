package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
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
func (c *Client) ListContainersByLabel(label string) ([]container.Summary, error) {
	if c == nil || c.cli == nil {
		return nil, errors.New("docker client not initialized")
	}
	f := make(client.Filters).Add("label", label)

	result, err := c.cli.ContainerList(c.ctx, client.ContainerListOptions{
		All:     true,
		Filters: f,
	})
	if err != nil {
		return nil, err
	}
	return result.Items, nil
}

// ListContainersAll returns all containers (running and stopped).
func (c *Client) ListContainersAll(ctx context.Context) ([]container.Summary, error) {
	if c == nil || c.cli == nil {
		return nil, errors.New("docker client not initialized")
	}
	result, err := c.cli.ContainerList(ctx, client.ContainerListOptions{
		All: true,
	})
	if err != nil {
		return nil, err
	}
	return result.Items, nil
}

// GetContainerStats retrieves real-time stats.
func (c *Client) GetContainerStats(ctx context.Context, containerID string) (*ContainerStats, error) {
	stats, err := c.cli.ContainerStats(ctx, containerID, client.ContainerStatsOptions{})
	if err != nil {
		return nil, err
	}
	defer stats.Body.Close()

	var v container.StatsResponse
	if err := json.NewDecoder(stats.Body).Decode(&v); err != nil {
		return nil, err
	}

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
	}, nil
}

// InspectContainer returns detailed information about a container.
func (c *Client) InspectContainer(ctx context.Context, containerID string) (client.ContainerInspectResult, error) {
	if c == nil || c.cli == nil {
		return client.ContainerInspectResult{}, errors.New("docker client not initialized")
	}
	return c.cli.ContainerInspect(ctx, containerID, client.ContainerInspectOptions{})
}

// ContainerLogs retrieves logs from a container.
func (c *Client) ContainerLogs(ctx context.Context, containerID string, follow bool, tail string) (io.ReadCloser, error) {
	if c == nil || c.cli == nil {
		return nil, errors.New("docker client not initialized")
	}
	opts := client.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     follow,
		Tail:       tail,
	}
	return c.cli.ContainerLogs(ctx, containerID, opts)
}

// RestartContainer restarts a container with an optional timeout.
func (c *Client) RestartContainer(ctx context.Context, containerID string, timeout time.Duration) error {
	if c == nil || c.cli == nil {
		return errors.New("docker client not initialized")
	}
	_, err := c.cli.ContainerRestart(ctx, containerID, client.ContainerRestartOptions{})
	return err
}

// StopContainer stops a running container.
func (c *Client) StopContainer(ctx context.Context, containerID string) error {
	if c == nil || c.cli == nil {
		return errors.New("docker client not initialized")
	}
	_, err := c.cli.ContainerStop(ctx, containerID, client.ContainerStopOptions{})
	return err
}

// StartContainer starts a stopped container.
func (c *Client) StartContainer(ctx context.Context, containerID string) error {
	if c == nil || c.cli == nil {
		return errors.New("docker client not initialized")
	}
	_, err := c.cli.ContainerStart(ctx, containerID, client.ContainerStartOptions{})
	return err
}
