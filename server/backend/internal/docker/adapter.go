package docker

import (
	"context"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

// Ensure RuntimeAdapter implements runtime.ContainerRuntime
var _ runtime.ContainerRuntime = (*RuntimeAdapter)(nil)

type RuntimeAdapter struct {
	client *Client
}

func NewRuntimeAdapter(client *Client) *RuntimeAdapter {
	return &RuntimeAdapter{client: client}
}

func (r *RuntimeAdapter) ComposeUp(ctx context.Context, path string) error {
	return r.client.ComposeUp(ctx, path)
}

func (r *RuntimeAdapter) ComposeDown(ctx context.Context, path string) error {
	return r.client.ComposeDown(ctx, path)
}

func (r *RuntimeAdapter) ComposePull(ctx context.Context, path string) error {
	return r.client.ComposePull(ctx, path)
}

func (r *RuntimeAdapter) ComposeStop(ctx context.Context, path string) error {
	return r.client.ComposeStop(ctx, path)
}

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

func (r *RuntimeAdapter) HealthCheck() error {
	return r.client.HealthCheck()
}

func (r *RuntimeAdapter) Close() error {
	return r.client.Close()
}
