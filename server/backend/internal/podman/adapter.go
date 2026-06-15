package podman

import (
	"context"
	"io"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

// Ensure RuntimeAdapter implements runtime.ContainerRuntime
var _ runtime.ContainerRuntime = (*RuntimeAdapter)(nil)

// RuntimeAdapter adapts Podman client calls to the runtime interface.
type RuntimeAdapter struct {
	client *Client
}

// NewRuntimeAdapter wraps a Podman client to satisfy the runtime interface.
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
func (r *RuntimeAdapter) ListContainersByLabel(ctx context.Context, label string) ([]runtime.ContainerInfo, error) {
	return r.client.ListContainersByLabel(ctx, label)
}


// ListContainersAll returns all containers (running and stopped).
func (r *RuntimeAdapter) ListContainersAll(ctx context.Context) ([]runtime.ContainerInfo, error) {
	return r.client.ListContainersAll(ctx)
}


// GetContainerStats retrieves resource usage stats for a container.
func (r *RuntimeAdapter) GetContainerStats(ctx context.Context, containerID string) (*runtime.ContainerStats, error) {
	return r.client.GetContainerStats(ctx, containerID)
}


// InspectContainer returns detailed information about a container.
func (r *RuntimeAdapter) InspectContainer(ctx context.Context, containerID string) (*runtime.ContainerInspectResult, error) {
	return r.client.InspectContainer(ctx, containerID)
}


// ContainerLogs retrieves logs from a container.
func (r *RuntimeAdapter) ContainerLogs(ctx context.Context, containerID string, options runtime.LogOptions) (io.ReadCloser, error) {
	return r.client.ContainerLogs(ctx, containerID, options)
}


// FindContainersByInstanceID finds all containers matching an instance ID via multiple label strategies.
// Tries: libreserv.app label, com.docker.compose.project label, com.docker.compose.project=libreserv-{id} label, name prefix.
func (r *RuntimeAdapter) FindContainersByInstanceID(ctx context.Context, instanceID string) ([]runtime.ContainerInfo, error) {
	containers, err := r.client.ListContainersAll(ctx)
	if err != nil {
		return nil, err
	}

	var result []runtime.ContainerInfo
	for _, ci := range containers {
		if matchesInstance(ci, instanceID) {
			result = append(result, ci)
		}
	}

	return result, nil
}


// matchesInstance returns true if the container matches the given instance ID.
func matchesInstance(ci runtime.ContainerInfo, instanceID string) bool {
	if ci.Labels != nil {
		if ci.Labels["libreserv.app"] == instanceID {
			return true
		}
		if ci.Labels["com.docker.compose.project"] == instanceID {
			return true
		}
		if ci.Labels["com.docker.compose.project"] == "libreserv-"+instanceID {
			return true
		}
	}

	for _, name := range ci.Names {
		cleanName := strings.TrimPrefix(name, "/")
		if strings.HasPrefix(cleanName, instanceID+"-") || strings.HasPrefix(cleanName, instanceID+"_") {
			return true
		}
	}

	return false
}

// HealthCheck checks Podman connectivity.
func (r *RuntimeAdapter) HealthCheck() error {
	return r.client.HealthCheck()
}

// Close releases the adapter's Podman client.
func (r *RuntimeAdapter) Close() error {
	return r.client.Close()
}
