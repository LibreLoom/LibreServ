package tests

import (
	"strings"
	"testing"
)

// The host-execution contract: a test runs on the host only when it names the
// constraint that keeps it out of a container. These tests pin the registry's
// behaviour so "host" can never quietly become an oversight again.

func TestHostTestsDeclareTheirReason(t *testing.T) {
	hostTests := 0
	for _, test := range DefaultRegistry.List() {
		if test.Container != ContainerHost {
			continue
		}
		hostTests++
		if strings.TrimSpace(test.NeedsHost) == "" {
			t.Errorf("test %q runs on the host without a NeedsHost reason", test.ID)
		}
	}
	if hostTests == 0 {
		t.Fatal("no host tests found; this test would pass vacuously")
	}
}

func TestContainerizedTestsCarryNoHostReason(t *testing.T) {
	for _, test := range DefaultRegistry.List() {
		if test.Container == ContainerHost {
			continue
		}
		if test.NeedsHost != "" {
			t.Errorf("test %q runs in container %q but sets NeedsHost %q",
				test.ID, test.Container, test.NeedsHost)
		}
	}
}

func TestAddPanicsOnHostWithoutReason(t *testing.T) {
	r := &Registry{tests: make(map[string]*Test)}
	defer func() {
		if recover() == nil {
			t.Fatal("Add accepted a host test with no NeedsHost reason")
		}
	}()
	r.Add(&Test{ID: "sneaky", Container: ContainerHost})
}

func TestAddPanicsOnReasonWithoutHost(t *testing.T) {
	r := &Registry{tests: make(map[string]*Test)}
	defer func() {
		if recover() == nil {
			t.Fatal("Add accepted a containerized test carrying a NeedsHost reason")
		}
	}()
	r.Add(&Test{ID: "confused", Container: "golang:1.27-alpine", NeedsHost: "leftover"})
}

// quick is the profile an agent runs after an edit, so it must be fully
// containerized: a host test there would run against the developer's machine
// instead of a pinned image.
func TestNoHostTestsInQuickProfile(t *testing.T) {
	// Import cycle: config imports tests, so the quick test-ID list is spelled
	// out here. Keep it in step with config.Profiles["quick"].
	quick := []string{
		"go-fmt", "go-vet", "go-test", "go-build", "go-rollback-test",
		"frontend-lint", "frontend-test", "frontend-typecheck",
		"connect-fmt", "connect-vet", "connect-test", "connect-build",
		"luna-connect-fmt", "luna-connect-vet", "luna-connect-test", "luna-connect-build",
	}
	for _, test := range DefaultRegistry.GetByIDs(quick) {
		if test.Container == ContainerHost {
			t.Errorf("quick-profile test %q runs on the host; containerize it", test.ID)
		}
	}
}
