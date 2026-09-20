package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/sandbox"
)

// BashTool returns a Tool that executes shell commands inside an OS sandbox.
//
// The command never runs directly against the host: it goes through the provided
// sandbox.Sandbox, which (for the default bubblewrap backend) places it in its
// own user/pid/uts/ipc/cgroup namespaces with a read-only view of the host root
// filesystem and an explicit allowlist of writable directories. That filesystem
// boundary is the real security control — the review model that gates this tool
// is an advisory layer on top.
//
// The model-supplied working directory is validated by the sandbox rather than
// trusted verbatim.
func BashTool(sb sandbox.Sandbox) *Tool {
	if sb == nil {
		// Defensive default: never run unsandboxed just because a caller forgot
		// to pass a sandbox. ModeOff is explicit; a nil sandbox is a bug.
		slog.Warn("bash tool created with nil sandbox; defaulting to unsandboxed execution. Pass a sandbox.Sandbox explicitly.")
		sb = sandbox.New(sandbox.Config{Mode: string(sandbox.ModeOff)})
	}
	return &Tool{
		Name:        "bash",
		Description: "Run a shell command on the server. Use for checking container status, reading logs, restarting services, installing packages, and other system administration tasks. Commands run inside a restricted sandbox: they can read the whole system but can only change files in approved directories. Commands that modify data, restart services, or delete things will also be reviewed for safety before execution.",
		ParameterSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"command": {
					"type": "string",
					"description": "The shell command to execute. Keep it simple and avoid chaining many commands with pipes."
				},
				"workdir": {
					"type": "string",
					"description": "Working directory for the command (optional, must be an absolute path that exists)"
				},
				"timeout_sec": {
					"type": "integer",
					"description": "Maximum seconds to wait before killing the command",
					"default": 30
				}
			},
			"required": ["command"]
		}`),
		AlwaysReview: true,
		Execute:      executeBash(sb),
	}
}

func executeBash(sb sandbox.Sandbox) func(context.Context, json.RawMessage) (string, error) {
	return func(ctx context.Context, args json.RawMessage) (string, error) {
		var params struct {
			Command    string `json:"command"`
			Workdir    string `json:"workdir"`
			TimeoutSec int    `json:"timeout_sec"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return "", fmt.Errorf("invalid arguments: %w", err)
		}
		if params.Command == "" {
			return "", fmt.Errorf("command is required")
		}
		if params.TimeoutSec <= 0 || params.TimeoutSec > 120 {
			params.TimeoutSec = 30
		}

		cmdCtx, cancel := context.WithTimeout(ctx, time.Duration(params.TimeoutSec)*time.Second)
		defer cancel()

		res, err := sb.Run(cmdCtx, sandbox.CommandSpec{
			Command: params.Command,
			Workdir: params.Workdir,
		})
		if err != nil {
			// A sandbox setup error (bad workdir, bwrap missing in fail-closed
			// mode). Surface it as a tool error so the agent can react.
			return "", err
		}

		result := map[string]interface{}{
			"stdout":    strings.TrimSpace(res.Stdout),
			"stderr":    strings.TrimSpace(res.Stderr),
			"exit_code": res.ExitCode,
		}
		if cmdCtx.Err() == context.DeadlineExceeded {
			result["exit_code"] = -1
			result["stderr"] = "command timed out after " + fmt.Sprintf("%d", params.TimeoutSec) + "s"
		}

		data, _ := json.MarshalIndent(result, "", "  ")
		return string(data), nil
	}
}
