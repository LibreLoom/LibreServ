// Package sandbox provides an OS-level execution boundary for agent tool
// commands. The bash tool does NOT run commands directly against the host;
// it runs them through a Sandbox implementation.
//
// The default backend is bubblewrap (bwrap), which executes the command inside
// a set of Linux namespaces (user, pid, uts, ipc, cgroup) with a read-only view
// of the host root filesystem and an explicit allowlist of writable directories.
// This means an agent command cannot modify system files (/etc, /usr, /boot,
// /bin, ...) even if the model is tricked into trying — the filesystem is
// mounted read-only and a namespace isolates the process tree.
//
// This is a real OS boundary, not a string filter. The review model remains an
// advisory layer on top; the sandbox is the security boundary that holds when
// the model misbehaves.
package sandbox

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// Mode names the active sandbox backend.
type Mode string

const (
	// ModeAuto uses bubblewrap when available, falling back to an unsandboxed
	// executor with a warning when bwrap is missing.
	ModeAuto Mode = "auto"
	// ModeBwrap requires bubblewrap; Run fails closed if bwrap is unavailable.
	ModeBwrap Mode = "bwrap"
	// ModeOff runs commands directly with no OS boundary. Intended only for
	// development. A warning is logged on every invocation.
	ModeOff Mode = "off"
)

// Config controls sandbox behavior.
type Config struct {
	// Mode selects the backend: "auto" (default), "bwrap", or "off".
	Mode string
	// Workdirs are absolute host directories made writable inside the sandbox.
	// These are bind-mounted read-write; everything else under / is read-only.
	Workdirs []string
	// Network controls network egress. When false, a separate network
	// namespace is used (--unshare-net) and the command cannot reach the
	// network. Note: this also isolates the host's Unix sockets (e.g. the
	// Podman socket under /run), so most management commands require Network=true.
	Network bool
	// Binary overrides the bubblewrap binary path (default "bwrap").
	Binary string
}

// CommandSpec describes a single command to run inside the sandbox.
type CommandSpec struct {
	// Command is the shell string passed to `bash -c`.
	Command string
	// Workdir is the requested working directory. It must be absolute and must
	// exist on the host. If empty, it defaults to the first Workdir or /tmp.
	// The model supplies this value, so it is validated — never trusted raw.
	Workdir string
}

// Result is the outcome of a sandboxed command.
type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// Sandbox is the execution boundary a tool uses to run a shell command.
type Sandbox interface {
	// Mode returns the active backend name for logging/UI.
	Mode() Mode
	// Available reports whether the backend can actually run commands. A bwrap
	// backend reports false when the bwrap binary is missing.
	Available() bool
	// Run executes the command spec inside the sandbox.
	Run(ctx context.Context, spec CommandSpec) (*Result, error)
}

// New constructs a Sandbox for the given config. Mode is normalized: an empty
// mode resolves to ModeAuto.
func New(cfg Config) Sandbox {
	mode := normalizeMode(cfg.Mode)
	switch mode {
	case ModeOff:
		slog.Warn("agent sandbox disabled (mode=off): commands run unsandboxed on the host. This is unsafe outside development.")
		return &noneSandbox{}
	case ModeBwrap:
		b := newBwrap(cfg)
		if !b.Available() {
			slog.Error("agent sandbox mode=bwrap but bubblewrap binary not found; bash tool will refuse commands", "binary", b.cfg.Binary)
		}
		return b
	default: // ModeAuto
		b := newBwrap(cfg)
		if b.Available() {
			return b
		}
		slog.Warn("agent sandbox: bubblewrap not available, falling back to unsandboxed execution. Install bwrap for a real OS boundary.", "binary", b.cfg.Binary)
		return &noneSandbox{}
	}
}

func normalizeMode(m string) Mode {
	switch strings.ToLower(strings.TrimSpace(m)) {
	case "", "auto":
		return ModeAuto
	case "bwrap", "bubblewrap", "bubble":
		return ModeBwrap
	case "off", "none", "disabled":
		return ModeOff
	default:
		slog.Warn("agent sandbox: unknown mode, defaulting to auto", "mode", m)
		return ModeAuto
	}
}

// ErrSandboxUnavailable is returned when a bwrap sandbox cannot execute because
// the backend is not usable and the configured mode does not allow fallback.
var ErrSandboxUnavailable = errors.New("sandbox backend is not available (bubblewrap not found)")

// commandExists reports whether the named binary is on PATH.
func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// runInPgroup runs a command, capturing stdout/stderr, and ensures the entire
// process group is killed if ctx is cancelled. This prevents sandboxed child
// processes (e.g. a bash that spawned children) from outliving a timeout.
func runInPgroup(ctx context.Context, binary string, args, env []string) *Result {
	cmd := exec.CommandContext(ctx, binary, args...)
	if env != nil {
		cmd.Env = env
	}
	// Put the command and its children in their own process group so a timeout
	// can clean up the whole tree, not just the direct child.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// On cancellation, kill the entire process group.
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return os.ErrProcessDone
	}

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	res := &Result{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: 0,
	}
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			res.ExitCode = exitErr.ExitCode()
		} else if ctx.Err() != nil {
			res.ExitCode = -1
		} else {
			res.ExitCode = -1
			res.Stderr = appendLine(res.Stderr, runErr.Error())
		}
	}
	return res
}

// appendLine joins an extra message onto a possibly-empty string.
func appendLine(s, line string) string {
	if s == "" {
		return line
	}
	return s + "\n" + line
}
