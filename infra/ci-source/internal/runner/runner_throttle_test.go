package runner

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
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
	args, env := hostThrottle(in, 0, 0, 0, fakeLook("nice", "ionice", "systemd-run"))
	if !reflect.DeepEqual(args, in) || len(env) != 0 {
		t.Fatalf("got %v %v", args, env)
	}
}

func TestHostThrottleWraps(t *testing.T) {
	args, env := hostThrottle([]string{"sh", "-c", "x"}, 250000, 1<<30, 19, fakeLook("nice", "ionice", "systemd-run"))
	want := []string{"/bin/systemd-run", "--user", "--scope", "--quiet", "-pCPUQuota=250%", "-pMemoryMax=1073741824",
		"/bin/nice", "-n", "19", "/bin/ionice", "-c3", "sh", "-c", "x"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v", args)
	}
	if env[0] != "CARGO_BUILD_JOBS=3" {
		t.Fatalf("env = %v", env)
	}
}

func TestHostThrottleSkipsMissingTools(t *testing.T) {
	args, _ := hostThrottle([]string{"sh"}, 100000, 0, 10, fakeLook())
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
