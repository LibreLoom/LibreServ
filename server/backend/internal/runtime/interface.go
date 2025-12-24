package runtime

import (
	"context"
)

// ContainerRuntime defines the interface for container operations
type ContainerRuntime interface {
	// Compose operations
	ComposeUp(ctx context.Context, composePath string) error
	ComposeDown(ctx context.Context, composePath string) error
	ComposePull(ctx context.Context, composePath string) error
	ComposeStop(ctx context.Context, composePath string) error

	// Container operations
	ListContainersByLabel(label string) ([]ContainerInfo, error)

	// Health check
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
}
