package runner

import (
	"errors"
	"os"
	"reflect"
	"strconv"
	"testing"
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

func TestContainerCommandNice(t *testing.T) {
	if got := containerCommand("go test", 0); !reflect.DeepEqual(got, []string{"sh", "-c", "go test"}) {
		t.Fatalf("no nice: %v", got)
	}
	got := containerCommand("go test", 19)
	if len(got) != 6 || got[4] != "19" || got[5] != "go test" {
		t.Fatalf("nice: %v", got)
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
