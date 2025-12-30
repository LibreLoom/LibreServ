package docker

import (
	"context"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

// Ensure RuntimeAdapter implements runtime.ContainerRuntime
var _ runtime.ContainerRuntime = (*RuntimeAdapter)(nil)

// RuntimeAdapter adapts Docker client calls to the runtime interface.
type RuntimeAdapter struct {
	client *Client
}

// NewRuntimeAdapter wraps a Docker client to satisfy the runtime interface.
func NewRuntimeAdapter(client *Client) *RuntimeAdapter {
	return &RuntimeAdapter{client: client}
}

// ComposeUp starts a compose stack at the given path.
func (r *RuntimeAdapter) ComposeUp(ctx context.Context, path string) error {
	return r.client.ComposeUp(ctx, path)
}

// ComposeDown stops and removes a compose stack at the given path.
func (r *RuntimeAdapter) ComposeDown(ctx context.Context, path string) error {
	return r.client.ComposeDown(ctx, path)
}

// ComposePull pulls images for a compose stack at the given path.
func (r *RuntimeAdapter) ComposePull(ctx context.Context, path string) error {
	return r.client.ComposePull(ctx, path)
}

// ComposeStop stops a compose stack at the given path.
func (r *RuntimeAdapter) ComposeStop(ctx context.Context, path string) error {
	return r.client.ComposeStop(ctx, path)
}

// ListContainersByLabel returns container info for a label selector.
func (r *RuntimeAdapter) ListContainersByLabel(label string) ([]runtime.ContainerInfo, error) {
	containers, err := r.client.ListContainersByLabel(label)
	if err != nil {
		return nil, err
	}

	var result []runtime.ContainerInfo
	for _, c := range containers {
		result = append(result, runtime.ContainerInfo{
			ID:     c.ID,
			Names:  c.Names,
			Image:  c.Image,
			State:  c.State,
			Status: c.Status,
		})
	}
	return result, nil
}

// HealthCheck checks Docker connectivity.
func (r *RuntimeAdapter) HealthCheck() error {
	return r.client.HealthCheck()
}

// Close releases the adapter's Docker client.
func (r *RuntimeAdapter) Close() error {
	return r.client.Close()
}
