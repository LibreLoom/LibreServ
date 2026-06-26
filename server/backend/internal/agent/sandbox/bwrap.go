package sandbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// defaultPath is the PATH handed to the sandboxed shell. It deliberately omits
// nothing a normal admin shell would have — the read-only rootfs is what limits
// damage, not an incomplete PATH.
const defaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// bwrapSandbox runs commands inside a bubblewrap container with a read-only
// view of the host root filesystem and an allowlist of writable directories.
type bwrapSandbox struct {
	cfg Config
}

func newBwrap(cfg Config) *bwrapSandbox {
	if cfg.Binary == "" {
		cfg.Binary = "bwrap"
	}
	cfg.Workdirs = normalizeWorkdirs(cfg.Workdirs)
	return &bwrapSandbox{cfg: cfg}
}

func (b *bwrapSandbox) Mode() Mode { return ModeBwrap }

func (b *bwrapSandbox) Available() bool {
	return commandExists(b.cfg.Binary)
}

func (b *bwrapSandbox) Run(ctx context.Context, spec CommandSpec) (*Result, error) {
	if !b.Available() {
		return nil, ErrSandboxUnavailable
	}
	args, err := buildBwrapArgs(b.cfg, spec)
	if err != nil {
		return nil, err
	}
	slog.Debug("agent sandbox: executing bwrap", "workdir", spec.Workdir, "network", b.cfg.Network)
	// bwrap owns its environment via --clearenv/--setenv; pass nil so the host
	// environment does not leak into the sandbox.
	return runInPgroup(ctx, b.cfg.Binary, args, nil), nil
}

// errEmptyCommand is returned by buildBwrapArgs when no command is supplied.
var errEmptyCommand = errors.New("command is required")

// buildBwrapArgs constructs the bubblewrap argument vector for a command spec.
// It is a pure function of (cfg, spec) and performs no I/O except resolving the
// working directory's existence, which is required for --chdir to succeed.
//
// The resulting sandbox:
//   - runs in its own user, pid, uts, ipc, and cgroup namespaces (and a
//     separate network namespace when Network is false);
//   - sees the host root filesystem read-only (so /etc, /usr, /bin, ... cannot
//     be modified, even rm -rf / is harmless);
//   - may write only to the configured Workdirs plus private /tmp and /var/tmp;
//   - starts in a validated working directory (the model's value is checked, not
//     trusted verbatim).
func buildBwrapArgs(cfg Config, spec CommandSpec) ([]string, error) {
	if strings.TrimSpace(spec.Command) == "" {
		return nil, errEmptyCommand
	}

	workdir, err := resolveWorkdir(cfg, spec.Workdir)
	if err != nil {
		return nil, err
	}

	args := []string{
		// Namespaces: isolate identity, processes, hostname, IPC, and cgroups.
		"--unshare-user",
		"--unshare-pid",
		"--unshare-uts",
		"--unshare-ipc",
		"--unshare-cgroup",
		// Die with the server process and detach from any controlling TTY.
		"--die-with-parent",
		"--new-session",
		// Read-only view of the entire host root. This is the core boundary:
		// system files cannot be modified from inside the sandbox.
		"--ro-bind", "/", "/",
		// Minimal device and proc filesystems.
		"--dev", "/dev",
		"--proc", "/proc",
		// Private writable scratch space (not shared with the host).
		"--tmpfs", "/tmp",
		"--tmpfs", "/var/tmp",
	}
	if !cfg.Network {
		args = append(args, "--unshare-net")
	}

	// Writable bind-mounts for each allowlisted directory.
	for _, wd := range normalizeWorkdirs(cfg.Workdirs) {
		args = append(args, "--bind", wd, wd)
	}

	args = append(args,
		"--chdir", workdir,
		// Start from an empty environment; add only what the shell needs.
		"--clearenv",
		"--setenv", "PATH", defaultPath,
		"--setenv", "HOME", workdir,
		"--setenv", "LANG", "C.UTF-8",
		"--",
		"bash", "-c", spec.Command,
	)
	return args, nil
}

// resolveWorkdir validates the model-supplied working directory. It must be
// absolute and must exist as a directory on the host. An empty value defaults
// to the first configured Workdir, or /tmp when none are configured.
//
// This exists because the previous implementation took workdir verbatim from the
// model and passed it straight to exec.Cmd.Dir — a model could point it at a
// nonexistent path or a traversal target. Here we Clean it and confirm it is a
// real directory before the sandbox uses it for --chdir.
func resolveWorkdir(cfg Config, requested string) (string, error) {
	if requested == "" {
		if dirs := normalizeWorkdirs(cfg.Workdirs); len(dirs) > 0 {
			return dirs[0], nil
		}
		return "/tmp", nil
	}
	cleaned := filepath.Clean(requested)
	if !filepath.IsAbs(cleaned) {
		return "", fmt.Errorf("workdir must be an absolute path, got %q", requested)
	}
	// Reject backslash-based or relative-looking inputs after cleaning. Clean
	// already resolves "..", so a cleaned absolute path is safe to chdir into.
	info, err := os.Stat(cleaned)
	if err != nil {
		return "", fmt.Errorf("workdir is not accessible: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("workdir is not a directory: %s", cleaned)
	}
	return cleaned, nil
}

// normalizeWorkdirs cleans, de-duplicates, and sorts the writable directory list.
// It drops relative paths and nonexistent entries (with a warning) so the
// sandbox never tries to bind-mount something that does not exist — bwrap would
// fail at runtime otherwise.
func normalizeWorkdirs(dirs []string) []string {
	seen := make(map[string]bool, len(dirs))
	out := make([]string, 0, len(dirs))
	for _, d := range dirs {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		cleaned := filepath.Clean(d)
		if !filepath.IsAbs(cleaned) {
			slog.Warn("agent sandbox: ignoring non-absolute workdir", "workdir", d)
			continue
		}
		if seen[cleaned] {
			continue
		}
		if _, err := os.Stat(cleaned); err != nil {
			slog.Warn("agent sandbox: ignoring nonexistent workdir", "workdir", cleaned, "error", err)
			continue
		}
		seen[cleaned] = true
		out = append(out, cleaned)
	}
	sort.Strings(out)
	return out
}

// Compile-time check that bwrapSandbox implements Sandbox.
var _ Sandbox = (*bwrapSandbox)(nil)
