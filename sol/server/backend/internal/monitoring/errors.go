package monitoring

import "errors"

var (
	// ErrRuntimeUnavailable indicates monitoring could not access the container runtime (client missing, daemon down, or permission denied).
	ErrRuntimeUnavailable = errors.New("runtime unavailable")
	// ErrNoContainers indicates no containers could be found for the requested app/project.
	ErrNoContainers = errors.New("no containers found")
)

// IsRuntimeUnavailable reports whether the error indicates the container runtime is unavailable.
func IsRuntimeUnavailable(err error) bool {
	return errors.Is(err, ErrRuntimeUnavailable)
}

// IsNoContainers reports whether the error indicates no containers were found.
func IsNoContainers(err error) bool {
	return errors.Is(err, ErrNoContainers)
}
