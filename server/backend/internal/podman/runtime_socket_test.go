package podman

import (
	"errors"
	"strings"
	"testing"
)
// Docker daemon" branch produces a plain-language, actionable message — not
// the old opaque "container runtime not running or not accessible".
func TestComposeErrorCannotConnectDocker(t *testing.T) {
	output := []byte("Cannot connect to the Docker daemon at unix:///run/user/1000/podman/podman.sock. Is the docker daemon running?")
	err := composeError("up", output, errors.New("exit status 1"))

	msg := err.Error()
	if strings.Contains(msg, "container runtime not running or not accessible") {
		t.Fatalf("error should not contain the old opaque message, got: %s", msg)
	}
	// Must be plain-language: explain what's wrong and what to do.
	for _, want := range []string{"not running", "try again"} {
		if !strings.Contains(strings.ToLower(msg), want) {
			t.Fatalf("error message should mention %q, got: %s", want, msg)
		}
	}
}

// TestComposeErrorCannotConnectPodman verifies the Podman variant of the
// connection-failure message.
func TestComposeErrorCannotConnectPodman(t *testing.T) {
	output := []byte("Cannot connect to Podman. System error: connection refused")
	err := composeError("up", output, errors.New("exit status 1"))

	msg := err.Error()
	if strings.Contains(msg, "container runtime not running or not accessible") {
		t.Fatalf("error should not contain the old opaque message, got: %s", msg)
	}
	if !strings.Contains(strings.ToLower(msg), "not running") {
		t.Fatalf("error message should explain the daemon is not running, got: %s", msg)
	}
}

// TestComposeErrorPermissionDenied verifies the permission-denied branch is
// plain-language and actionable.
func TestComposeErrorPermissionDenied(t *testing.T) {
	output := []byte("permission denied while accessing /run/user/1000/podman/podman.sock")
	err := composeError("up", output, errors.New("exit status 1"))

	msg := err.Error()
	if strings.Contains(msg, "permission denied accessing runtime socket") {
		t.Fatalf("error should not contain the old terse message, got: %s", msg)
	}
	if !strings.Contains(strings.ToLower(msg), "permission") {
		t.Fatalf("error message should mention permission, got: %s", msg)
	}
}

// TestComposeErrorComposeProviderMissing verifies the missing-compose-provider
// branch is plain-language.
func TestComposeErrorComposeProviderMissing(t *testing.T) {
	output := []byte(`unknown command "compose"`)
	err := composeError("up", output, errors.New("exit status 1"))

	msg := err.Error()
	if strings.Contains(msg, "compose provider not found (install podman-compose or docker-compose)") {
		t.Fatalf("error should not contain the old terse message, got: %s", msg)
	}
	for _, want := range []string{"compose", "installed"} {
		if !strings.Contains(strings.ToLower(msg), want) {
			t.Fatalf("error message should mention %q, got: %s", want, msg)
		}
	}
}

// TestComposeErrorGeneric verifies the fallback branch surfaces the raw output
// (trimmed) so debugging is still possible.
func TestComposeErrorGeneric(t *testing.T) {
	output := []byte("some unexpected error from compose\n\n")
	err := composeError("up", output, errors.New("exit status 1"))

	msg := err.Error()
	if !strings.Contains(msg, "some unexpected error from compose") {
		t.Fatalf("fallback should include the raw output, got: %s", msg)
	}
	if strings.HasSuffix(msg, "\n") {
		t.Fatalf("fallback output should be trimmed, got: %q", msg)
	}
}

// TestRootlessSocketPath verifies the socket path is derived from
// XDG_RUNTIME_DIR.
func TestRootlessSocketPath(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)

	got := rootlessSocketPath()
	want := dir + "/podman/podman.sock"
	if got != want {
		t.Fatalf("rootlessSocketPath() = %q, want %q", got, want)
	}
}

// TestRootlessSocketPathUnset verifies an empty XDG_RUNTIME_DIR returns "".
func TestRootlessSocketPathUnset(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "")
	if got := rootlessSocketPath(); got != "" {
		t.Fatalf("rootlessSocketPath() with unset XDG_RUNTIME_DIR = %q, want empty", got)
	}
}

// TestEnsureSocketRunningNoXdgRuntime verifies EnsureSocketRunning returns
// false (without panicking) when XDG_RUNTIME_DIR is unset.
func TestEnsureSocketRunningNoXdgRuntime(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "")
	if EnsureSocketRunning() {
		t.Fatalf("EnsureSocketRunning should return false when XDG_RUNTIME_DIR is unset")
	}
}

// TestDaemonReachableMissingBinary verifies daemonReachable returns an error
// for a nonexistent binary (the exec itself fails).
func TestDaemonReachableMissingBinary(t *testing.T) {
	err := daemonReachable("/nonexistent/binary/that/does/not/exist")
	if err == nil {
		t.Fatalf("daemonReachable with missing binary should return an error")
	}
}

// TestHealthCheckNilClient verifies HealthCheck on a nil client returns an
// error rather than panicking.
func TestHealthCheckNilClient(t *testing.T) {
	var c *Client
	if err := c.HealthCheck(); err == nil {
		t.Fatalf("HealthCheck on nil client should return an error")
	}
}
