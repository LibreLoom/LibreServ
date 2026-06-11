package agent

import (
	"context"
	"testing"
	"time"
)

func TestNewLoop(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
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
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{}, "token", "user1", "conv1")
	if loop.config.MaxTurns != 10 {
		t.Errorf("default MaxTurns = %d, want 10", loop.config.MaxTurns)
	}
	if loop.config.MaxContextMessages != 80 {
		t.Errorf("default MaxContextMessages = %d, want 80", loop.config.MaxContextMessages)
	}
}

func TestLoadHistory(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
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
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")

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
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	loop.HandlePermissionResponse("nonexistent", true)
}

func TestStop(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	loop.Stop()

	select {
	case <-loop.stopCh:
	default:
		t.Error("stopCh should be closed after Stop()")
	}
}

func TestStopIdempotent(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	loop.Stop()
	loop.Stop()
}

func TestLoopEventsChannel(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	events := loop.Events()
	if events == nil {
		t.Fatal("Events() returned nil channel")
	}
}

func TestRunNoProvider(t *testing.T) {
	agent := NewAgent("agent-1", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5, TurnTimeout: time.Second}, "token", "user1", "conv1")

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
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{
		MaxTurns: 5,
		DataDirs: []string{"/var/lib/libreserv", "/etc/libreserv"},
	}, "token", "user1", "conv1")

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
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
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
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	summary := loop.buildContextSummary()
	if summary != "No prior conversation." {
		t.Errorf("empty summary = %q, want %q", summary, "No prior conversation.")
	}
}

func TestSummarizeOldMessagesNoProvider(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxContextMessages: 4}, "token", "user1", "conv1")

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
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{MaxContextMessages: 20}, "token", "user1", "conv1")
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
	loop := NewLoop(agent, nil, nil, nil, nil, LoopConfig{
		MaxTurns:       5,
		PermissionMode: "auto",
	}, "token", "user1", "conv1")

	// In auto mode, permission requests should auto-approve without blocking.
	result := loop.requestUserPermissionWithReason(context.Background(), "tc1", "bash", "test reason")
	if !result {
		t.Error("permission should auto-approve in auto mode")
	}
}
