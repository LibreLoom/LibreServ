package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/tools"
)

func TestNewLoop(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5}, "user1", "conv1")
	if loop == nil {
		t.Fatal("NewLoop returned nil")
	}
	if loop.userID != "user1" {
		t.Errorf("loop.userID = %q, want %q", loop.userID, "user1")
	}
	if loop.convID != "conv1" {
		t.Errorf("loop.convID = %q, want %q", loop.convID, "conv1")
	}
	if loop.agent == nil {
		t.Fatal("loop.agent is nil")
	}
	if loop.agent.ID != "test" {
		t.Errorf("loop.agent.ID = %q, want %q", loop.agent.ID, "test")
	}
}

func TestNewLoopDefaults(t *testing.T) {
	agent := NewAgent("test", "test-model", "circle", "#4ECDC4", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{}, "user1", "conv1")
	if loop.config.MaxTurns != 10 {
		t.Errorf("default MaxTurns = %d, want 10", loop.config.MaxTurns)
	}
	if loop.config.MaxContextMessages != 80 {
		t.Errorf("default MaxContextMessages = %d, want 80", loop.config.MaxContextMessages)
	}
}

func TestLoadHistory(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5}, "user1", "conv1")
	history := []Message{
		{Role: RoleUser, Content: "hello"},
		{Role: RoleAssistant, Content: "hi there"},
		{Role: RoleUser, Content: "how are you?"},
	}
	loop.LoadHistory(history)
	if len(loop.messages) != 3 {
		t.Fatalf("LoadHistory: got %d messages, want 3", len(loop.messages))
	}
	if loop.messages[0].Content != "hello" {
		t.Errorf("loop.messages[0].Content = %q, want %q", loop.messages[0].Content, "hello")
	}
}

func TestHandlePermissionResponse(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5}, "user1", "conv1")

	permCh := make(chan bool, 1)
	loop.pendingPermMu.Lock()
	loop.pendingPerm["test-id"] = permCh
	loop.pendingPermMu.Unlock()

	loop.HandlePermissionResponse("test-id", true)

	select {
	case approved := <-permCh:
		if !approved {
			t.Error("expected approval")
		}
	default:
		t.Error("permission response not delivered")
	}
}

func TestHandlePermissionResponseNonexistent(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5}, "user1", "conv1")
	loop.HandlePermissionResponse("nonexistent", true)
}

func TestStop(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5}, "user1", "conv1")
	loop.Stop()

	select {
	case <-loop.stopCh:
	default:
		t.Error("stopCh should be closed after Stop()")
	}
}

func TestStopIdempotent(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5}, "user1", "conv1")
	loop.Stop()
	loop.Stop()
}

func TestLoopEventsChannel(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5}, "user1", "conv1")
	events := loop.Events()
	if events == nil {
		t.Fatal("Events() returned nil channel")
	}
}

func TestRunNoProvider(t *testing.T) {
	agent := NewAgent("agent-1", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5, TurnTimeout: time.Second}, "user1", "conv1")

	done := make(chan struct{})
	go func() {
		defer close(done)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		loop.MarkConsumerReady()
		loop.Run(ctx, "test message")
	}()

	var events []Event
	for evt := range loop.Events() {
		events = append(events, evt)
	}
	<-done

	var gotError bool
	for _, e := range events {
		if e.Type == EventError {
			gotError = true
		}
	}
	if !gotError {
		t.Error("expected error event when agent has no provider")
	}
}

func TestIsDataDir(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{
		MaxTurns: 5,
		DataDirs: []string{"/var/lib/libreserv", "/etc/libreserv"},
	}, "user1", "conv1")

	tests := []struct {
		path     string
		expected bool
	}{
		{"/var/lib/libreserv/apps/nextcloud/config.php", true},
		{"/var/lib/libreserv", true},
		{"/etc/libreserv/libreserv.yaml", true},
		{"/etc/libreserv", true},
		{"/tmp/test.txt", false},
		{"/var/log/syslog", false},
		{"/home/user/data.txt", false},
		{"/var/lib/libreservx", false}, // different dir
	}

	for _, tt := range tests {
		result := loop.isDataDir(tt.path)
		if result != tt.expected {
			t.Errorf("isDataDir(%q) = %v, want %v", tt.path, result, tt.expected)
		}
	}
}

func TestBuildContextSummary(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5}, "user1", "conv1")
	loop.messages = []Message{
		{Role: RoleUser, Content: "my app is broken"},
		{Role: RoleAssistant, Content: "Let me check that for you."},
	}
	summary := loop.buildContextSummary()
	if summary == "" {
		t.Error("context summary should not be empty")
	}
	if summary == "No prior conversation." {
		t.Error("context summary should include messages")
	}
}

func TestBuildContextSummaryEmpty(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxTurns: 5}, "user1", "conv1")
	summary := loop.buildContextSummary()
	if summary != "No prior conversation." {
		t.Errorf("empty summary = %q, want %q", summary, "No prior conversation.")
	}
}

func TestSummarizeOldMessagesNoProvider(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxContextMessages: 4}, "user1", "conv1")

	msgs := []Message{
		{Role: RoleUser, Content: "a"},
		{Role: RoleAssistant, Content: "b"},
		{Role: RoleUser, Content: "c"},
		{Role: RoleAssistant, Content: "d"},
		{Role: RoleUser, Content: "e"},
	}
	result, err := loop.summarizeOldMessages(context.Background(), msgs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != len(msgs) {
		t.Errorf("without provider, should return original; got %d, want %d", len(result), len(msgs))
	}
}

func TestSummarizeOldMessagesBelowThreshold(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{MaxContextMessages: 20}, "user1", "conv1")
	msgs := []Message{
		{Role: RoleUser, Content: "hello"},
		{Role: RoleAssistant, Content: "hi"},
	}
	result, err := loop.summarizeOldMessages(context.Background(), msgs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 2 {
		t.Errorf("below threshold, should return original; got %d, want 2", len(result))
	}
}

func TestTruncate(t *testing.T) {
	if truncate("hello", 10) != "hello" {
		t.Error("truncate should return original if under maxLen")
	}
	result := truncate("hello world", 5)
	if result != "hello..." {
		t.Errorf("truncate('hello world', 5) = %q, want %q", result, "hello...")
	}
}

func TestEventTypesExist(t *testing.T) {
	// Verify all expected event types are defined.
	types := []EventType{
		EventAgentThinking,
		EventAgentMessage,
		EventToolCall,
		EventToolReview,
		EventPermissionRequest,
		EventToolResult,
		EventAgentResponse,
		EventDone,
		EventError,
		EventUsageUpdate,
	}
	for _, et := range types {
		if et == "" {
			t.Error("event type is empty string")
		}
	}
}

func TestPermissionModeAuto(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{
		MaxTurns:       5,
		PermissionMode: "auto",
	}, "user1", "conv1")

	// Auto mode means there is no human to confirm actions. Permission requests
	// must NOT auto-approve — they return false immediately so the caller records
	// a denial, rather than blocking until timeout. The review model is what
	// decides allow/deny in auto mode; this path is only a safety net.
	result := loop.requestUserPermissionWithReason(context.Background(), "tc1", "bash", "test reason")
	if result {
		t.Error("permission should NOT auto-approve in auto mode; it should return false (no human available)")
	}
}

// TestExecuteWithReview_AutoModeDenialRecordsFeedback proves that a denied tool
// call in autonomous mode records a tool-result message (so the agent learns why
// its call did not run and the tool-call protocol stays balanced). It uses a
// nil-provider review model, which in auto mode fails safe to ReviewDeny without
// calling the provider.
func TestExecuteWithReview_AutoModeDenialRecordsFeedback(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	reviewModel := NewReviewModel(nil, "review-model") // nil provider
	loop := NewLoop(agent, nil, reviewModel, LoopConfig{
		MaxTurns:       5,
		PermissionMode: "auto",
	}, "user1", "conv1")

	// Drain events so emit() never blocks.
	go func() {
		for range loop.Events() {
		}
	}()

	tool := &tools.Tool{
		Name:         "bash",
		AlwaysReview: true,
		Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
			t.Fatal("Execute must not run for a denied call")
			return "", nil
		},
	}

	tc := AgentToolCall{ID: "tc-deny", Name: "bash", Arguments: json.RawMessage(`{"command":"echo hi"}`)}
	executed, denied := loop.executeWithReview(context.Background(), tool, tc)

	if executed {
		t.Error("denied call should not be executed")
	}
	if !denied {
		t.Error("expected denied=true")
	}

	// The denial must be recorded as a tool result so the agent (and the
	// provider's tool-call protocol) see a response for this tool_call_id.
	var found bool
	for _, m := range loop.messages {
		if m.Role == RoleTool && m.ToolCallID == "tc-deny" && m.Content != "" {
			found = true
			if !strings.Contains(strings.ToLower(m.Content), "safety review") {
				t.Errorf("denial message does not explain the block: %q", m.Content)
			}
		}
	}
	if !found {
		t.Error("no tool-result message recorded for the denied call — agent gets no feedback")
	}
}

// writeToolWithDataDir builds a write tool whose path lands inside a configured
// data directory. Its Execute fails the test if reached in a deny scenario.
func writeToolWithDataDir(t *testing.T, path string, allowExecute bool) *tools.Tool {
	return &tools.Tool{
		Name:         "write",
		AlwaysReview: true,
		PathExtractor: func(args json.RawMessage) string {
			var p struct {
				Path string `json:"path"`
			}
			_ = json.Unmarshal(args, &p)
			return p.Path
		},
		Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
			if !allowExecute {
				t.Fatal("Execute must not run when the call is blocked")
			}
			return "wrote", nil
		},
	}
}

// TestExecuteWithReview_UserDataBlockedWhenUnattended proves the hard rule: a
// write to a protected data directory is blocked in autonomous mode (no human
// to confirm), without consulting the review model.
func TestExecuteWithReview_UserDataBlockedWhenUnattended(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	// nil reviewModel: if the data-dir check did not short-circuit, the loop
	// would dereference it and panic — so reaching the assertion proves review
	// was skipped.
	loop := NewLoop(agent, nil, nil, LoopConfig{
		MaxTurns:       5,
		PermissionMode: "auto",
		DataDirs:       []string{"/var/lib/libreserv"},
	}, "user1", "conv1")
	go func() {
		for range loop.Events() {
		}
	}()

	tool := writeToolWithDataDir(t, "/var/lib/libreserv/secret.txt", false)
	tc := AgentToolCall{ID: "tc-ud", Name: "write", Arguments: json.RawMessage(`{"path":"/var/lib/libreserv/secret.txt","content":"x"}`)}

	executed, denied := loop.executeWithReview(context.Background(), tool, tc)
	if executed || !denied {
		t.Fatalf("user-data write in auto mode: executed=%v denied=%v, want false/true", executed, denied)
	}
	var found bool
	for _, m := range loop.messages {
		if m.Role == RoleTool && m.ToolCallID == "tc-ud" && strings.Contains(m.Content, "data directory") {
			found = true
		}
	}
	if !found {
		t.Error("user-data block did not record a denial explaining the data-directory protection")
	}
}

// TestExecuteWithReview_UserDataEscalatesAndApproves proves the standard-mode
// path: a write to a protected data directory escalates to the user (emits a
// permission request) instead of going straight to the review model, and runs
// only after the user approves.
func TestExecuteWithReview_UserDataEscalatesAndApproves(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, LoopConfig{
		MaxTurns:    5,
		TurnTimeout: 30 * time.Second,
		DataDirs:    []string{"/var/lib/libreserv"},
		// standard mode (not "auto") so a human can confirm.
	}, "user1", "conv1")

	tool := writeToolWithDataDir(t, "/var/lib/libreserv/notes.txt", true)
	tc := AgentToolCall{ID: "tc-esc", Name: "write", Arguments: json.RawMessage(`{"path":"/var/lib/libreserv/notes.txt","content":"x"}`)}

	type result struct{ exec, denied bool }
	resCh := make(chan result, 1)
	go func() {
		e, d := loop.executeWithReview(context.Background(), tool, tc)
		resCh <- result{e, d}
	}()

	// Wait for the permission request, then approve it.
	for evt := range loop.Events() {
		if evt.Type == EventPermissionRequest {
			loop.HandlePermissionResponse("tc-esc", true)
			break
		}
	}

	res := <-resCh
	if !res.exec || res.denied {
		t.Fatalf("after approval: executed=%v denied=%v, want true/false", res.exec, res.denied)
	}
}

// TestExecuteWithReview_SafeWriteGoesToReview proves a write to a NON-data-dir
// path is not short-circuited by the data-dir rule and reaches the review model
// (here: nil, which in auto mode fails safe to deny).
func TestExecuteWithReview_SafeWriteGoesToReview(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, NewReviewModel(nil, "rm"), LoopConfig{
		MaxTurns:       5,
		PermissionMode: "auto",
		DataDirs:       []string{"/var/lib/libreserv"},
	}, "user1", "conv1")
	go func() {
		for range loop.Events() {
		}
	}()

	tool := writeToolWithDataDir(t, "/tmp/safe.txt", false)
	tc := AgentToolCall{ID: "tc-safe", Name: "write", Arguments: json.RawMessage(`{"path":"/tmp/safe.txt","content":"x"}`)}

	executed, denied := loop.executeWithReview(context.Background(), tool, tc)
	// /tmp is not a data dir, so the data-dir rule does not fire; the call goes
	// to the (nil-provider) review model, which in auto mode fails safe to deny.
	if executed || !denied {
		t.Fatalf("safe write through review in auto mode: executed=%v denied=%v, want false/true", executed, denied)
	}
	var found bool
	for _, m := range loop.messages {
		if m.Role == RoleTool && m.ToolCallID == "tc-safe" && strings.Contains(strings.ToLower(m.Content), "safety review") {
			found = true
		}
	}
	if !found {
		t.Error("safe write should be denied by the review model, not the data-dir rule")
	}
}
