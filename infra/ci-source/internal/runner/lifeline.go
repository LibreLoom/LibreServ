package runner

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// lifelinePrefix names the per-run lock files in the cache directory.
const lifelinePrefix = ".ci-run-"

// lifeline is a lock file this ci process holds for as long as it lives.
// Containers see it at /cache and stop themselves once nobody holds it, so
// killing ci (even with kill -9) can't leave test containers running.
type lifeline struct {
	f    *os.File
	path string
}

func newLifeline(cacheDir string) (*lifeline, error) {
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(cacheDir, lifelinePrefix+strconv.Itoa(os.Getpid())+".lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, err
	}
	removeStaleLifelines(cacheDir)
	return &lifeline{f: f, path: path}, nil
}

// hostPath is the lock file's full path, for tests that run on the host.
func (l *lifeline) hostPath() string {
	if l == nil {
		return ""
	}
	return l.path
}

// name is the file's name; inside a container it is /cache/<name>.
func (l *lifeline) name() string {
	if l == nil {
		return ""
	}
	return filepath.Base(l.path)
}

func (l *lifeline) close() {
	if l == nil {
		return
	}
	os.Remove(l.path)
	l.f.Close()
}

// removeStaleLifelines deletes lock files left by runs that no longer exist.
func removeStaleLifelines(cacheDir string) {
	entries, _ := os.ReadDir(cacheDir)
	for _, e := range entries {
		pid, ok := strings.CutPrefix(e.Name(), lifelinePrefix)
		if !ok {
			continue
		}
		pid = strings.TrimSuffix(pid, ".lock")
		if !ownerAlive(pid) {
			os.Remove(filepath.Join(cacheDir, e.Name()))
		}
	}
}

// containerCommand wraps a test command so that the container
//   - runs the command under nice, when the run asks for a lower priority, and
//   - stops itself within a few seconds of the ci process (the holder of the
//     lifeline lock file) disappearing.
//
// The wrapper stays PID 1 and runs the command as its child: a container's
// PID 1 ignores signals it has no handler for, so the command itself could not
// be told to stop from inside. Without flock in the image there is no
// watchdog, and the command still runs.
func containerCommand(command string, nice int, lifelineName string) []string {
	lock := ""
	if lifelineName != "" {
		lock = "/cache/" + lifelineName
	}
	const script = `lock=$1; nice=$2; cmd=$3
trap 'kill -9 -1 2>/dev/null; exit 137' TERM
if [ "$nice" -gt 0 ] && command -v nice >/dev/null 2>&1; then
  nice -n "$nice" sh -c "$cmd" &
else
  sh -c "$cmd" &
fi
child=$!
if [ -n "$lock" ] && command -v flock >/dev/null 2>&1; then
  ( while sleep 3; do flock -n -s "$lock" true && kill -TERM 1; done ) &
fi
wait $child`
	return []string{"sh", "-c", script, "sh", lock, fmt.Sprint(nice), command}
}

// hostCommand wraps a host-run test so it stops itself within a few seconds of
// the ci process disappearing, like containerCommand does for containers. The
// wrapper must be started as the leader of its own process group
// (SysProcAttr.Setpgid): a watchdog in a session of its own then stops that
// whole group, including anything the test started, such as podman builds.
// Without flock or setsid on the host the command runs unguarded.
func hostCommand(command, lockPath string) []string {
	if lockPath == "" {
		return []string{"sh", "-c", command}
	}
	const script = `lock=$1; shift
if command -v flock >/dev/null 2>&1 && command -v setsid >/dev/null 2>&1; then
  pg=$$
  "$@" &
  child=$!
  setsid sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 3; flock -n -s "$2" true && { kill -TERM "-$3"; sleep 5; kill -KILL "-$3"; break; }; done' sh "$child" "$lock" "$pg" &
  wait $child
else
  exec "$@"
fi`
	return []string{"sh", "-c", script, "sh", lockPath, "sh", "-c", command}
}
