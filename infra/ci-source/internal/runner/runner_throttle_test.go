package runner

import (
	"errors"
	"reflect"
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
