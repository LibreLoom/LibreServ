package runner

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func fakeLook(have ...string) func(string) (string, error) {
	return func(n string) (string, error) {
		for _, h := range have {
			if h == n {
				return "/bin/" + n, nil
			}
		}
		return "", errors.New("missing")
	}
}

func TestHostThrottleNoLimitsIsUnchanged(t *testing.T) {
	in := []string{"sh", "-c", "x"}
	args, env, _ := hostThrottle(in, 0, 0, 0, fakeLook("nice", "ionice", "systemd-run"))
	if !reflect.DeepEqual(args, in) || len(env) != 0 {
		t.Fatalf("got %v %v", args, env)
	}
}

func TestHostThrottleWraps(t *testing.T) {
	args, env, _ := hostThrottle([]string{"sh", "-c", "x"}, 250000, 1<<30, 19, fakeLook("nice", "ionice", "systemd-run"))
	want := []string{"/bin/systemd-run", "--user", "--scope", "--quiet", "-pCPUQuota=250%", "-pMemoryMax=1073741824",
		"/bin/nice", "-n", "19", "/bin/ionice", "-c3", "sh", "-c", "x"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v", args)
	}
	have := map[string]bool{}
	for _, e := range env {
		have[e] = true
	}
	for _, want := range []string{"CARGO_BUILD_JOBS=3", "GOMAXPROCS=3", "VITEST_MAX_WORKERS=3"} {
		if !have[want] {
			t.Fatalf("env missing %s: %v", want, env)
		}
	}
	nested := false
	for _, e := range env {
		if strings.HasPrefix(e, "CONTAINERS_CONF_OVERRIDE=") {
			nested = true
		}
	}
	if !nested {
		t.Fatalf("nested podman containers are not kept inside the scope: %v", env)
	}
}

func TestHostThrottleSkipsMissingTools(t *testing.T) {
	args, _, warn := hostThrottle([]string{"sh"}, 100000, 0, 10, fakeLook())
	if warn == "" {
		t.Fatal("expected a warning that the test is not capped")
	}
	if !reflect.DeepEqual(args, []string{"sh"}) {
		t.Fatalf("args = %v", args)
	}
}

func TestJobSharesSplitTheRunLimits(t *testing.T) {
	r := &Runner{cpuQuota: 320000, memoryLimit: 8 << 30, jobs: 2}
	if got := r.jobCPUQuota(); got != 160000 {
		t.Fatalf("cpu share = %d", got)
	}
	if got := r.jobMemoryLimit(); got != 4<<30 {
		t.Fatalf("memory share = %d", got)
	}
	r = &Runner{jobs: 2}
	if r.jobCPUQuota() != 0 || r.jobMemoryLimit() != 0 {
		t.Fatal("no limits should stay unlimited")
	}
}

func TestContainerCommandArgs(t *testing.T) {
	got := containerCommand("go test", 19, ".ci-run-7.lock")
	want := []string{"/cache/.ci-run-7.lock", "19", "go test"}
	if len(got) != 7 || !reflect.DeepEqual(got[4:], want) {
		t.Fatalf("args = %v", got)
	}
	if got := containerCommand("x", 0, ""); got[4] != "" || got[5] != "0" {
		t.Fatalf("no lifeline, no nice = %v", got)
	}
}

func TestContainerCommandRunsAndPassesExitCode(t *testing.T) {
	for code, cmd := range map[int]string{0: "true", 3: "exit 3"} {
		args := containerCommand(cmd, 0, "")
		if err := exec.Command(args[0], args[1:]...).Run(); code == 0 && err != nil {
			t.Fatalf("%s: %v", cmd, err)
		} else if ee, ok := err.(*exec.ExitError); code != 0 && (!ok || ee.ExitCode() != code) {
			t.Fatalf("%s: want exit %d, got %v", cmd, code, err)
		}
	}
}

func TestLifelineIsHeldWhileRunAlive(t *testing.T) {
	dir := t.TempDir()
	l, err := newLifeline(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := exec.Command("flock", "-n", "-s", filepath.Join(dir, l.name()), "true").Run(); err == nil {
		t.Fatal("lifeline should be exclusively locked while ci runs")
	}
	l.close()
	if _, err := os.Stat(filepath.Join(dir, l.name())); !os.IsNotExist(err) {
		t.Fatal("lifeline file should be removed on close")
	}
}

func TestOwnerAlive(t *testing.T) {
	if !ownerAlive(strconv.Itoa(os.Getpid())) {
		t.Fatal("this process should count as alive")
	}
	for _, bad := range []string{"", "x", "0", "-1", "2147483646"} {
		if ownerAlive(bad) {
			t.Fatalf("%q should not count as alive", bad)
		}
	}
}

func TestHostCommandStopsWhenCiIsGone(t *testing.T) {
	for _, tool := range []string{"flock", "setsid"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " not installed")
		}
	}
	dir := t.TempDir()
	l, err := newLifeline(dir)
	if err != nil {
		t.Fatal(err)
	}
	args := hostCommand("sleep 60 & wait", l.hostPath())
	cmd := exec.Command(args[0], args[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case <-done:
		t.Fatal("test stopped although ci still holds the lifeline")
	case <-time.After(5 * time.Second):
	}
	// Dropping the lock stands in for ci being killed.
	l.f.Close()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		t.Fatal("test kept running after ci was gone")
	}
}

// A container started by a bounded host command must land in that command's
// cgroup, or the command's limits do not cover it.
func TestNestedPodmanStaysInScope(t *testing.T) {
	for _, tool := range []string{"systemd-run", "podman"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " not installed")
		}
	}
	if exec.Command("podman", "image", "exists", "alpine").Run() != nil {
		t.Skip("alpine image not cached")
	}
	script := `own=$(cut -d: -f3 /proc/self/cgroup); inner=$(podman run --rm alpine cat /proc/self/cgroup 2>&1 | head -1); ` +
		`id=$(podman run -d alpine sleep 5); pid=$(podman inspect "$id" --format '{{.State.Pid}}'); c=$(cut -d: -f3 /proc/$pid/cgroup); podman rm -f "$id" >/dev/null; ` +
		`[ "$c" = "$own" ] && echo same || echo "different: $c vs $own"`
	args, env, _ := hostThrottle([]string{"sh", "-c", script}, 100000, 1<<30, 0, exec.LookPath)
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "same") {
		t.Fatalf("container left the scope: %v %s", err, out)
	}
}

func TestBuildFlags(t *testing.T) {
	if got := buildFlags(160000, 4<<30); got != "--cpu-period=100000 --cpu-quota=160000 --memory=4294967296" {
		t.Fatalf("flags = %q", got)
	}
	if got := buildFlags(0, 1<<20); got != "--memory=1048576" {
		t.Fatalf("memory only = %q", got)
	}
	if got := buildFlags(0, 0); got != "" {
		t.Fatalf("no limits = %q", got)
	}
}

func TestHostThrottlePutsPodmanShimFirst(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PATH", "/usr/bin")
	_, env, _ := hostThrottle([]string{"sh"}, 160000, 1<<30, 0, fakeLook("systemd-run"))
	have := map[string]bool{}
	for _, e := range env {
		have[e] = true
	}
	if !strings.HasPrefix(env[slicesIndexPrefix(env, "PATH=")], "PATH="+filepath.Join(os.Getenv("XDG_CACHE_HOME"), "libreserv-ci", "bin")+":/usr/bin") {
		t.Fatalf("shim not first on PATH: %v", env)
	}
	if !have["LIBRESERV_CI_BUILD_FLAGS=--cpu-period=100000 --cpu-quota=160000 --memory=1073741824"] {
		t.Fatalf("build flags missing: %v", env)
	}
}

func slicesIndexPrefix(env []string, p string) int {
	for i, e := range env {
		if strings.HasPrefix(e, p) {
			return i
		}
	}
	return -1
}

// The shim must add the job's flags to builds only, and pass every other
// podman invocation through untouched.
func TestPodmanShimInjectsFlagsIntoBuildOnly(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	shim := podmanShim()
	if shim == "" {
		t.Fatal("shim not written")
	}
	fake := t.TempDir()
	if err := os.WriteFile(filepath.Join(fake, "podman"), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ args, want string }{
		{"build -t x .", "build --cpu-quota=7 --memory=9 -t x ."},
		{"--log-level=info build -t x .", "--log-level=info build --cpu-quota=7 --memory=9 -t x ."},
		{"image build .", "image build --cpu-quota=7 --memory=9 ."},
		{"run --rm build", "run --rm build"},
		{"run -t x build", "run -t x build"},
		{"ps -a", "ps -a"},
	} {
		cmd := exec.Command("sh", "-c", "podman "+c.args)
		cmd.Env = append(os.Environ(), "PATH="+shim+":"+fake+":"+os.Getenv("PATH"), "LIBRESERV_CI_BUILD_FLAGS=--cpu-quota=7 --memory=9")
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%q: %v", c.args, err)
		}
		if got := strings.TrimSpace(string(out)); got != c.want {
			t.Errorf("podman %s\n got  %q\n want %q", c.args, got, c.want)
		}
	}
}
