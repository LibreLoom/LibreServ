package runner

import (
	"os"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

// `ci check` is host-first: a check runs on the host when this machine can run
// it, and in its container when it cannot. These tests pin the decision, since
// the failure mode of getting it wrong is silent — a check that quietly runs
// against the wrong toolchain, or one that falls back to a container for no
// reason and makes the inner loop slow again.

func TestHostReadinessFallsBackWithoutToolchain(t *testing.T) {
	goTest := &tests.Test{ID: "go-vet", Container: "golang:1.27-alpine", Command: "go vet ./..."}

	if ok, why := hostReadinessWith(goTest, "/repo", fakeLook()); ok {
		t.Fatalf("ran a Go check on a machine with no Go; want a fallback")
	} else if why == "" {
		t.Fatal("fell back without saying why")
	}

	if ok, why := hostReadinessWith(goTest, "/repo", fakeLook("go")); !ok {
		t.Fatalf("refused a Go check on a machine that has Go: %s", why)
	}
}

func TestHostReadinessNeedsGofmtForFormatChecks(t *testing.T) {
	fmtTest := &tests.Test{ID: "go-fmt", Container: "golang:1.27-alpine", Command: "gofmt -l ."}
	if ok, _ := hostReadinessWith(fmtTest, "/repo", fakeLook("go")); ok {
		t.Fatal("ran a gofmt check on a machine with no gofmt")
	}
	if ok, why := hostReadinessWith(fmtTest, "/repo", fakeLook("go", "gofmt")); !ok {
		t.Fatalf("refused a gofmt check on a machine that has gofmt: %s", why)
	}
}

func TestHostReadinessNeedsNodeModulesForNpmScripts(t *testing.T) {
	repo := t.TempDir()
	workdir := filepath.Join(repo, "sol", "server", "frontend")
	if err := os.MkdirAll(workdir, 0o755); err != nil {
		t.Fatal(err)
	}
	lint := &tests.Test{
		ID:        "frontend-lint",
		Container: "node:26-alpine",
		Command:   "npm run lint",
		WorkDir:   "/repo/sol/server/frontend",
	}
	look := fakeLook("node", "npm")

	// No node_modules: an npm script would die on a missing eslint, so the
	// container (which warms its own copy) is the honest choice.
	if ok, why := hostReadinessWith(lint, repo, look); ok {
		t.Fatal("ran an npm script with no node_modules")
	} else if why == "" {
		t.Fatal("fell back without saying why")
	}

	if err := os.MkdirAll(filepath.Join(workdir, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if ok, why := hostReadinessWith(lint, repo, look); !ok {
		t.Fatalf("refused an npm script whose workdir has node_modules: %s", why)
	}
}

func TestHostReadinessLeavesImageOnlyTestsInContainers(t *testing.T) {
	for _, tc := range []struct {
		name string
		test *tests.Test
		look func(string) (string, error)
	}{
		{
			name: "repo-built image",
			test: &tests.Test{ID: "luna-ci", Container: tests.LocalImagePrefix + "luna-ci", Command: "bash ci.sh"},
			look: fakeLook("go", "node", "npm", "cargo"),
		},
		{
			name: "playwright image",
			test: &tests.Test{ID: "luna-web-e2e", Container: "mcr.microsoft.com/playwright:v1.64.1-noble", Command: "npx playwright test"},
			look: fakeLook("go", "node", "npm"),
		},
		{
			name: "unknown image",
			test: &tests.Test{ID: "mystery", Container: "some/other:1", Command: "true"},
			look: fakeLook("go", "node", "npm"),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if ok, why := hostReadinessWith(tc.test, "/repo", tc.look); ok {
				t.Fatalf("%s ran on the host with no host recipe", tc.test.ID)
			} else if why == "" {
				t.Fatal("fell back without saying why")
			}
		})
	}
}

func TestHostTestsAlwaysRunOnHost(t *testing.T) {
	// A test that declares Container: "host" cannot run in a container at all,
	// so no mode may send it there.
	hostTest := &tests.Test{ID: "podman-build", Container: tests.ContainerHost, NeedsHost: "needs the host podman"}
	for _, mode := range []RunMode{ModeAuto, ModeHost, ModeContainer} {
		r := &Runner{mode: mode, outputChan: make(chan OutputLine, 10)}
		if !r.runsOnHost(hostTest) {
			t.Fatalf("mode %v sent a host-only test to a container", mode)
		}
	}
}

func TestModeForcesTheSide(t *testing.T) {
	goTest := &tests.Test{ID: "go-vet", Container: "golang:1.27-alpine", Command: "go vet ./..."}

	// ModeHost runs it even though this machine may lack Go: a missing toolchain
	// is then a failure, which is what the caller asked to see.
	r := &Runner{mode: ModeHost, outputChan: make(chan OutputLine, 10)}
	if !r.runsOnHost(goTest) {
		t.Fatal("ModeHost did not force the host")
	}

	// ModeContainer never asks the machine, so it needs no toolchain at all.
	r = &Runner{mode: ModeContainer, outputChan: make(chan OutputLine, 10)}
	if r.runsOnHost(goTest) {
		t.Fatal("ModeContainer did not force a container")
	}
}
