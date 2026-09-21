package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/sandbox"
)

// runBash invokes the bash tool with the given sandbox and JSON args, returning
// the parsed result map. Fails the test on tool error unless allowError is set.
func runBash(t *testing.T, sb sandbox.Sandbox, args string, allowError bool) map[string]interface{} {
	t.Helper()
	tool := BashTool(sb)
	out, err := tool.Execute(context.Background(), json.RawMessage(args))
	if err != nil && !allowError {
		t.Fatalf("bash Execute failed: %v (out=%s)", err, out)
	}
	var res map[string]interface{}
	if err == nil {
		if jerr := json.Unmarshal([]byte(out), &res); jerr != nil {
			t.Fatalf("bash output not JSON: %v (raw=%q)", jerr, out)
		}
	}
	return res
}

func TestBashTool_RequiresCommand(t *testing.T) {
	sb := sandbox.New(sandbox.Config{Mode: string(sandbox.ModeOff)})
	_, err := BashTool(sb).Execute(context.Background(), json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected error for missing command")
	}
	if !strings.Contains(err.Error(), "command is required") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestBashTool_InvalidArgs(t *testing.T) {
	sb := sandbox.New(sandbox.Config{Mode: string(sandbox.ModeOff)})
	_, err := BashTool(sb).Execute(context.Background(), json.RawMessage(`not json`))
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

// TestBashTool_OutputContractOff verifies the tool's JSON output shape
// (stdout/stderr/exit_code) is preserved when running unsandboxed. This is the
// contract the agent loop and SSE persistence depend on.
func TestBashTool_OutputContractOff(t *testing.T) {
	sb := sandbox.New(sandbox.Config{Mode: string(sandbox.ModeOff)})
	res := runBash(t, sb, `{"command":"echo hello-agent"}`, false)

	if got := res["stdout"]; got != "hello-agent" {
		t.Errorf("stdout = %v, want %q", got, "hello-agent")
	}
	if got, _ := res["exit_code"].(float64); got != 0 {
		t.Errorf("exit_code = %v, want 0", res["exit_code"])
	}
}

func TestBashTool_NonzeroExit(t *testing.T) {
	sb := sandbox.New(sandbox.Config{Mode: string(sandbox.ModeOff)})
	res := runBash(t, sb, `{"command":"exit 7"}`, false)
	if got, _ := res["exit_code"].(float64); got != 7 {
		t.Errorf("exit_code = %v, want 7", res["exit_code"])
	}
}

func TestBashTool_RejectsBadWorkdir(t *testing.T) {
	// A nonexistent workdir must be rejected before any command runs, regardless
	// of backend. Use the off backend so this is deterministic without bwrap.
	sb := sandbox.New(sandbox.Config{Mode: string(sandbox.ModeOff)})
	_, err := BashTool(sb).Execute(context.Background(), json.RawMessage(`{"command":"echo hi","workdir":"/no/such/dir/xyz"}`))
	if err == nil {
		t.Fatal("expected error for nonexistent workdir")
	}
}

func TestBashTool_TimeoutSurfacesExitMinusOne(t *testing.T) {
	sb := sandbox.New(sandbox.Config{Mode: string(sandbox.ModeOff)})
	res := runBash(t, sb, `{"command":"sleep 30","timeout_sec":1}`, false)
	if got, _ := res["exit_code"].(float64); got != -1 {
		t.Errorf("exit_code = %v, want -1 on timeout", res["exit_code"])
	}
	if got := res["stderr"]; !strings.Contains(got.(string), "timed out") {
		t.Errorf("expected timeout message in stderr, got %v", res["stderr"])
	}
}

// TestBashTool_BwrapReadOnlyRoot is a live test: when bwrap is available, a
// write to /etc is blocked by the read-only root filesystem, proving the tool
// is actually running through the sandbox rather than directly on the host.
func TestBashTool_BwrapReadOnlyRoot(t *testing.T) {
	sb := sandbox.New(sandbox.Config{Mode: string(sandbox.ModeBwrap), Network: true})
	if !sb.Available() {
		t.Skip("bwrap not installed; skipping live bash-tool sandbox test")
	}
	res := runBash(t, sb, `{"command":"echo x > /etc/libreserv_bwrap_escape; echo done"}`, false)
	// The redirect fails on the read-only filesystem; the echo still runs.
	stderr, _ := res["stderr"].(string)
	if !strings.Contains(stderr, "Read-only file system") {
		t.Errorf("expected /etc write blocked by sandbox, got stderr=%q", stderr)
	}
}
