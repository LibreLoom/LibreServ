package runner

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// How a job is bounded, in one place. A job (container or host command) gets an
// equal share of the run's limits, from three layers that cover each other:
//
//   - a hard cap: the container runtime's cgroup for containers, a systemd user
//     scope for host commands;
//   - a lower priority (nice / ionice / CPU shares), so the desktop stays smooth;
//   - the tools' own worker counts (parallelismEnv), so they size themselves to
//     the share instead of starting one worker per host core and being throttled.
//
// Host commands that start containers themselves (podman builds in the release
// tests and luna/ci.sh) must stay inside the scope's cgroup: podman otherwise
// puts every container in its own unlimited cgroup. nestedPodmanConf does that.

// cpuPeriod is the CFS period, in microseconds, that cpuQuota is measured in.
const cpuPeriod = 100000

// parallelismEnv sizes the common build and test tools to a job's CPU share
// (cpuQuota in microseconds per 100ms period; 0 = unlimited, no env).
func parallelismEnv(cpuQuota int64) []string {
	if cpuQuota <= 0 {
		return nil
	}
	n := strconv.FormatInt(max((cpuQuota+cpuPeriod-1)/cpuPeriod, 1), 10)
	return []string{
		"GOMAXPROCS=" + n,
		"CARGO_BUILD_JOBS=" + n,
		"RUST_TEST_THREADS=" + n,
		"MAKEFLAGS=-j" + n,
		"CMAKE_BUILD_PARALLEL_LEVEL=" + n,
		"VITEST_MAX_WORKERS=" + n,
		"VITEST_MAX_THREADS=" + n,
		"VITEST_MAX_FORKS=" + n,
		"UV_THREADPOOL_SIZE=" + n,
		"GRADLE_OPTS=-Dorg.gradle.workers.max=" + n + " -Dorg.gradle.parallel=false",
	}
}

// nestedPodmanConf writes (once) a containers.conf override that keeps
// containers started by a host command inside that command's cgroup, so the
// scope's limits apply to them too. It returns "" if the file can't be written.
func nestedPodmanConf() string {
	base, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	dir := filepath.Join(base, "libreserv-ci")
	if os.MkdirAll(dir, 0o700) != nil {
		return ""
	}
	path := filepath.Join(dir, "containers-bounded.conf")
	const conf = "[containers]\ncgroups = \"disabled\"\n"
	if cur, err := os.ReadFile(path); err != nil || string(cur) != conf {
		if os.WriteFile(path, []byte(conf), 0o600) != nil {
			return ""
		}
	}
	return path
}

// hostThrottle wraps args in nice / ionice / a systemd user scope as the limits
// ask, and returns env that sizes build tools to the CPU share and keeps nested
// podman containers inside the scope. cpuQuota is microseconds per 100ms
// period. If a limit was asked for but cannot be enforced (no systemd-run), the
// command still runs, and the returned warning says it is not capped.
func hostThrottle(args []string, cpuQuota, memLimit int64, nice int, look func(string) (string, error)) (out []string, env []string, warning string) {
	if nice > 0 {
		if p, err := look("ionice"); err == nil {
			args = append([]string{p, "-c3"}, args...)
		}
		if p, err := look("nice"); err == nil {
			args = append([]string{p, "-n", strconv.Itoa(nice)}, args...)
		}
	}
	env = parallelismEnv(cpuQuota)
	if cpuQuota > 0 || memLimit > 0 {
		p, err := look("systemd-run")
		if err != nil {
			return args, env, "systemd-run is not installed, so this host test is not CPU or memory capped (it only runs at lower priority)"
		}
		scope := []string{p, "--user", "--scope", "--quiet"}
		if cpuQuota > 0 {
			scope = append(scope, fmt.Sprintf("-pCPUQuota=%d%%", cpuQuota/1000))
		}
		if memLimit > 0 {
			scope = append(scope, fmt.Sprintf("-pMemoryMax=%d", memLimit))
		}
		args = append(scope, args...)
		if conf := nestedPodmanConf(); conf != "" {
			env = append(env, "CONTAINERS_CONF_OVERRIDE="+conf)
		}
	}
	return args, env, ""
}
