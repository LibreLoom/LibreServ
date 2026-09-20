package runtime

import (
	"context"
	"io"
)

// ContainerRuntime defines the interface for container operations
type ContainerRuntime interface {
	ComposeUp(ctx context.Context, composePath string) error
	ComposeDown(ctx context.Context, composePath string) error
	ComposePull(ctx context.Context, composePath string) error
	ComposeStop(ctx context.Context, composePath string) error

	ListContainersByLabel(ctx context.Context, label string) ([]ContainerInfo, error)
	ListContainersAll(ctx context.Context) ([]ContainerInfo, error)
	GetContainerStats(ctx context.Context, containerID string) (*ContainerStats, error)
	InspectContainer(ctx context.Context, containerID string) (*ContainerInspectResult, error)
	ContainerLogs(ctx context.Context, containerID string, options LogOptions) (io.ReadCloser, error)
	FindContainersByInstanceID(ctx context.Context, instanceID string) ([]ContainerInfo, error)

	HealthCheck() error
	Close() error
}

// ContainerInfo represents basic container information
type ContainerInfo struct {
	ID     string
	Names  []string
	Image  string
	State  string
	Status string
	Labels map[string]string
}

// ContainerStats holds resource usage metrics for a container
type ContainerStats struct {
	CPUPercent  float64
	MemoryUsage uint64
	MemoryLimit uint64
	NetworkRx   uint64
	NetworkTx   uint64
}

// LogOptions controls log streaming behavior
type LogOptions struct {
	Follow bool
	Tail   string
}

// ContainerInspectResult wraps container inspection data
type ContainerInspectResult struct {
	ID    string
	Name  string
	TTY   bool
	State ContainerState
	Raw   []byte // original JSON payload for tools that need it
}

// ContainerState represents the running state of a container
type ContainerState struct {
	Running     bool
	Paused      bool
	Restarting  bool
	OOMKilled   bool
	Dead        bool
	Pid         int
	ExitCode    int
	Error       string
	StartedAt   string
	FinishedAt  string
	HealthState string
}
