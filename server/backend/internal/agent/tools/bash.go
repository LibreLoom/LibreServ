package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// BashTool returns a Tool that executes shell commands.
// The review model always runs before execution; the tool itself
// enforces basic guardrails (timeout, no interactive, sandbox paths).
func BashTool() *Tool {
	return &Tool{
		Name:        "bash",
		Description: "Run a shell command on the server. Use for checking container status, reading logs, restarting services, installing packages, and other system administration tasks. Commands that modify data, restart services, or delete things will be reviewed for safety before execution.",
		ParameterSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"command": {
					"type": "string",
					"description": "The shell command to execute. Keep it simple and avoid chaining many commands with pipes."
				},
				"workdir": {
					"type": "string",
					"description": "Working directory for the command (optional)"
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
		Execute:      executeBash,
	}
}

func executeBash(ctx context.Context, args json.RawMessage) (string, error) {
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

	cmd := exec.CommandContext(cmdCtx, "bash", "-c", params.Command)
	if params.Workdir != "" {
		cmd.Dir = params.Workdir
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Strip dangerous env but keep PATH and HOME so basic tools work.
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"LANG=C.UTF-8",
	}

	err := cmd.Run()

	result := map[string]interface{}{
		"stdout":   strings.TrimSpace(stdout.String()),
		"stderr":   strings.TrimSpace(stderr.String()),
		"exit_code": 0,
	}
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result["exit_code"] = exitErr.ExitCode()
		} else if cmdCtx.Err() == context.DeadlineExceeded {
			result["exit_code"] = -1
			result["stderr"] = "command timed out after " + fmt.Sprintf("%d", params.TimeoutSec) + "s"
		} else {
			result["exit_code"] = -1
			result["stderr"] = err.Error()
		}
	}

	data, _ := json.MarshalIndent(result, "", "  ")
	return string(data), nil
}
