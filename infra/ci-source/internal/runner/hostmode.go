package runner

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

// RunMode is where a run executes its tests.
type RunMode int

const (
	// ModeAuto runs each test on the host when this machine can run it, and in
	// its container when it cannot. It is the default for `ci check`: the inner
	// loop should not pay for an image pull, a mount and a container start when
	// the toolchain is sitting right there.
	ModeAuto RunMode = iota
	// ModeHost runs every test on the host, whether or not this machine has
	// what it needs. A missing toolchain is then a test failure, not a fallback.
	ModeHost
	// ModeContainer runs every test in its container, except the ones that
	// declare Container: "host" because a container cannot run them at all.
	ModeContainer
)

func (m RunMode) String() string {
	switch m {
	case ModeHost:
		return "host"
	case ModeContainer:
		return "containers"
	}
	return "host where possible"
}

// hostDecision decides where one test runs. When the answer is "its container"
// in auto mode, why says which toolchain this machine is missing — that reason
// is printed by the caller, because a silent fallback would hide which toolchain
// produced the result.
func (r *Runner) hostDecision(t *tests.Test) (onHost bool, why string) {
	if t.Container == tests.ContainerHost {
		return true, ""
	}
	switch r.mode {
	case ModeHost:
		return true, ""
	case ModeContainer:
		return false, ""
	}
	ok, why := hostReadiness(t, r.repoPath)
	return ok, why
}

// runsOnHost is hostDecision without the explanation, for callers that only
// need the answer.
func (r *Runner) runsOnHost(t *tests.Test) bool {
	onHost, _ := r.hostDecision(t)
	return onHost
}

// needsContainers reports whether any test in the list will run in a container,
// which is what decides whether the container-side caches are worth warming.
func (r *Runner) needsContainers(testList []*tests.Test) bool {
	for _, t := range testList {
		if !r.runsOnHost(t) {
			return true
		}
	}
	return false
}

// hostReadiness reports whether this machine can run t directly, and when it
// cannot, why — in words a person can act on, because the reason is printed
// when the test falls back to its container.
//
// The test is a container command: it was written to run in an image that
// carries the toolchain. Running it on the host means substituting whatever
// this machine has, so the only honest answer is "yes" when the tools the
// command names are present and "no, here is what is missing" otherwise.
func hostReadiness(t *tests.Test, repoPath string) (bool, string) {
	return hostReadinessWith(t, repoPath, exec.LookPath)
}

// hostReadinessWith is hostReadiness with the PATH lookup injected, so the
// decision can be tested without depending on the machine running the tests.
func hostReadinessWith(t *tests.Test, repoPath string, look func(string) (string, error)) (bool, string) {
	if t.Container == tests.ContainerHost {
		return true, ""
	}

	switch {
	case strings.HasPrefix(t.Container, tests.LocalImagePrefix):
		return false, fmt.Sprintf("%s carries toolchains this machine may not have", t.Container)
	case strings.HasPrefix(t.Container, "mcr.microsoft.com/playwright"):
		return false, "its browsers come from the image"
	case strings.HasPrefix(t.Container, "golang:"):
		return goHostReadiness(t, look)
	case strings.HasPrefix(t.Container, "node:"):
		return nodeHostReadiness(t, repoPath, look)
	}
	return false, fmt.Sprintf("there is no host recipe for %s", t.Container)
}

func goHostReadiness(t *tests.Test, look func(string) (string, error)) (bool, string) {
	if _, err := look("go"); err != nil {
		return false, "no Go toolchain on this machine"
	}
	if strings.Contains(t.Command, "gofmt") {
		if _, err := look("gofmt"); err != nil {
			return false, "no gofmt on this machine"
		}
	}
	return true, ""
}

func nodeHostReadiness(t *tests.Test, repoPath string, look func(string) (string, error)) (bool, string) {
	if _, err := look("node"); err != nil {
		return false, "no Node.js on this machine"
	}
	if !strings.Contains(t.Command, "npm") {
		return true, ""
	}
	if _, err := look("npm"); err != nil {
		return false, "no npm on this machine"
	}
	// An npm script resolves its tools (eslint, tsc, vitest) from the workdir's
	// node_modules. Without one the host run dies on a missing binary rather
	// than checking anything, so the container — which warms its own copy — is
	// the honest choice.
	dir := hostWorkDir(repoPath, t.WorkDir)
	if dir == "" {
		return true, ""
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules")); err != nil {
		return false, "no node_modules in " + t.WorkDir
	}
	return true, ""
}

// hostWorkDir maps an in-container workdir under /repo to the host path. It is
// the package-level form of Runner.hostWorkDir, for callers that only have the
// repo path.
func hostWorkDir(repoPath, inContainerWorkDir string) string {
	if rel, ok := strings.CutPrefix(inContainerWorkDir, "/repo"); ok {
		return filepath.Join(repoPath, strings.TrimPrefix(rel, "/"))
	}
	return inContainerWorkDir
}
