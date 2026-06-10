package docker

import "testing"

func TestDetectSocketArgs(t *testing.T) {
	paths := []string{
		"/run/user/1000/podman/podman.sock",
		"unix:///run/user/1000/podman/podman.sock",
	}
	for _, p := range paths {
		if _, err := connectViaSocket(p); err == nil {
			// We don't expect a real daemon in tests; just ensure no panic and an error is returned or client is created.
			continue
		}
	}
}
