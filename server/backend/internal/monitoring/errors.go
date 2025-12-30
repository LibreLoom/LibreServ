package monitoring

import "errors"

var (
	// ErrDockerUnavailable indicates monitoring could not access Docker (client missing, daemon down, or permission denied).
	ErrDockerUnavailable = errors.New("docker unavailable")
	// ErrNoContainers indicates no containers could be found for the requested app/project.
	ErrNoContainers = errors.New("no containers found")
)

// IsDockerUnavailable reports whether the error indicates Docker is unavailable.
func IsDockerUnavailable(err error) bool {
	return errors.Is(err, ErrDockerUnavailable)
}

// IsNoContainers reports whether the error indicates no containers were found.
func IsNoContainers(err error) bool {
	return errors.Is(err, ErrNoContainers)
}
