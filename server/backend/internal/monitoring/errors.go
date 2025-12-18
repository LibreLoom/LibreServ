package monitoring

import "errors"

var (
	// ErrDockerUnavailable indicates monitoring could not access Docker (client missing, daemon down, or permission denied).
	ErrDockerUnavailable = errors.New("docker unavailable")
	// ErrNoContainers indicates no containers could be found for the requested app/project.
	ErrNoContainers = errors.New("no containers found")
)

func IsDockerUnavailable(err error) bool {
	return errors.Is(err, ErrDockerUnavailable)
}

func IsNoContainers(err error) bool {
	return errors.Is(err, ErrNoContainers)
}
