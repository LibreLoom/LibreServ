package sandbox

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// noneSandbox runs commands directly on the host with no OS boundary. It is the
// fallback used in ModeAuto when bubblewrap is not installed, and the explicit
// backend for ModeOff (development only).
//
// It still validates the working directory (the model's value is not trusted
// verbatim) and confines the process to a minimal environment, but it provides
// NO filesystem or namespace isolation. Every invocation logs a warning so an
// operator running unsandboxed in production is hard to miss.
type noneSandbox struct{}

func (*noneSandbox) Mode() Mode      { return ModeOff }
func (*noneSandbox) Available() bool { return true }

func (n *noneSandbox) Run(ctx context.Context, spec CommandSpec) (*Result, error) {
	if strings.TrimSpace(spec.Command) == "" {
		return nil, errEmptyCommand
	}
	// resolveWorkdir with an empty Workdirs slice defaults to /tmp.
	workdir, err := resolveWorkdir(Config{}, spec.Workdir)
	if err != nil {
		return nil, err
	}

	slog.Warn("agent sandbox: running command with NO OS sandbox (mode=off or bwrap unavailable)", "workdir", workdir)

	// A minimal, sanitized environment. PATH omits nothing an admin shell would
	// have; HOME points at the workdir rather than the server process's home.
	env := []string{
		"PATH=" + defaultPath,
		"HOME=" + workdir,
		"LANG=C.UTF-8",
	}

	cmd := exec.CommandContext(ctx, "bash", "-c", spec.Command)
	cmd.Dir = workdir
	cmd.Env = env
	// Put the command and its children in their own process group so a timeout
	// can clean up the whole tree, not just the direct child.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
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
	res := &Result{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: 0}
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			res.ExitCode = exitErr.ExitCode()
		} else if ctx.Err() != nil {
			res.ExitCode = -1
			res.Stderr = "command timed out"
		} else {
			res.ExitCode = -1
			res.Stderr = appendLine(res.Stderr, runErr.Error())
		}
	}
	return res, nil
}

// Compile-time check that noneSandbox implements Sandbox.
var _ Sandbox = (*noneSandbox)(nil)
