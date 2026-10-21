package runner

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
// tests and luna/ci.sh) must stay inside the scope's limits: podman otherwise
// puts every container in its own unlimited cgroup. nestedPodmanConf does that
// for `podman run`. It does not for `podman build`: buildah puts every RUN step
// in its own transient scope whatever containers.conf says, so the podman shim
// (see podmanShim) hands each build the job's CPU and memory share as flags.

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

// podmanShimScript stands in for podman on a throttled host job's PATH. It runs
// the real podman unchanged, except that `podman build` (and `podman image
// build`) also gets $LIBRESERV_CI_BUILD_FLAGS, the job's CPU and memory share.
const podmanShimScript = `#!/bin/sh
# Written by ci. Passes everything to the real podman; adds the job's resource
# flags ($LIBRESERV_CI_BUILD_FLAGS) after "build", which buildah would otherwise
# run outside the job's cgroup.
dir=$(cd "$(dirname "$0")" && pwd)
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$dir" | paste -sd: -)
real=$(command -v podman) || { echo "podman: not found" >&2; exit 127; }
n=$#; pos=0; prev=; done=
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n - 1))
  set -- "$@" "$a"
  case $a in
    -*) ;;
    *)
      pos=$((pos + 1))
      if [ -z "$done" ] && [ "$a" = build ] && { [ "$pos" = 1 ] || { [ "$pos" = 2 ] && [ "$prev" = image ]; }; }; then
        # shellcheck disable=SC2086
        set -- "$@" $LIBRESERV_CI_BUILD_FLAGS
        done=1
      fi
      prev=$a
      ;;
  esac
done
exec "$real" "$@"
`

// podmanShim writes (once) the podman shim and returns its directory, or "" if
// it can't be written.
func podmanShim() string {
	base, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	dir := filepath.Join(base, "libreserv-ci", "bin")
	if os.MkdirAll(dir, 0o700) != nil {
		return ""
	}
	path := filepath.Join(dir, "podman")
	if cur, err := os.ReadFile(path); err != nil || string(cur) != podmanShimScript {
		tmp := path + "." + strconv.Itoa(os.Getpid())
		if os.WriteFile(tmp, []byte(podmanShimScript), 0o700) != nil || os.Rename(tmp, path) != nil {
			os.Remove(tmp)
			return ""
		}
	}
	return dir
}

// buildFlags is the podman build flags for a job's CPU and memory share.
func buildFlags(cpuQuota, memLimit int64) string {
	var f []string
	if cpuQuota > 0 {
		f = append(f, fmt.Sprintf("--cpu-period=%d", cpuPeriod), fmt.Sprintf("--cpu-quota=%d", cpuQuota))
	}
	if memLimit > 0 {
		f = append(f, fmt.Sprintf("--memory=%d", memLimit))
	}
	return strings.Join(f, " ")
}

// hostThrottle wraps args in nice / ionice / a systemd user scope as the limits
// ask, and returns env that sizes build tools to the CPU share and keeps nested
// podman containers inside the scope, and podman builds inside the job's share. cpuQuota is microseconds per 100ms
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
		if shim := podmanShim(); shim != "" {
			env = append(env, "PATH="+shim+string(os.PathListSeparator)+os.Getenv("PATH"), "LIBRESERV_CI_BUILD_FLAGS="+buildFlags(cpuQuota, memLimit))
		}
	}
	return args, env, ""
}
