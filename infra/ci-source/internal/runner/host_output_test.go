package runner

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHostOutputStreamsBeforeCommandFinishes(t *testing.T) {
	// The child cannot finish until its first line is delivered: a buffered
	// implementation deadlocks here instead of satisfying the handshake.
	ack := filepath.Join(t.TempDir(), "ack")
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", `echo ready; while [ ! -f "$1" ]; do sleep 0.01; done; printf partial >&2; exit 7`, "sh", ack)
	var lines []string
	out, err := streamHostCommand(cmd, func(line string) {
		lines = append(lines, line)
		if line == "ready" {
			if err := os.WriteFile(ack, nil, 0o600); err != nil {
				t.Error(err)
			}
		}
	})
	if err == nil || cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 7 {
		t.Fatalf("exit status: %v", err)
	}
	if out != "ready\npartial" || strings.Join(lines, "|") != "ready|partial" {
		t.Fatalf("output %q lines %v", out, lines)
	}
}

func TestHostOutputKeepsLongLinesAndStartErrors(t *testing.T) {
	long := strings.Repeat("x", 128*1024)
	cmd := exec.Command("sh", "-c", `printf '%s%s\n' "$LONG" "$LONG"`)
	cmd.Env = append(os.Environ(), "LONG="+long[:64*1024])
	// Avoid the Linux per-argument/environment value limit while testing a
	// line larger than bufio.Scanner's default 64 KiB.
	var got string
	out, err := streamHostCommand(cmd, func(line string) { got = line })
	if err != nil || got != long || out != long+"\n" {
		t.Fatalf("long output: %v (%d bytes)", err, len(out))
	}
	cmd = exec.Command(filepath.Join(t.TempDir(), "missing"))
	out, err = streamHostCommand(cmd, func(line string) { t.Errorf("unexpected line %q", line) })
	if err == nil || out != "" {
		t.Fatalf("start error: %v, output %q", err, out)
	}
}
