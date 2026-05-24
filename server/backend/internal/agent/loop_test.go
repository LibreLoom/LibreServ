package agent

import (
	"context"
	"testing"
	"time"
)

func TestNewLoop(t *testing.T) {
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	if loop == nil {
		t.Fatal("NewLoop returned nil")
	}
	if loop.userID != "user1" {
		t.Errorf("loop.userID = %q, want %q", loop.userID, "user1")
	}
	if loop.convID != "conv1" {
		t.Errorf("loop.convID = %q, want %q", loop.convID, "conv1")
	}
}

func TestNewLoopWithAgents(t *testing.T) {
	a1 := NewAgent("agent-1", "model-a", "diamond", "#FF6B35", "help", nil)
	a2 := NewAgent("agent-2", "model-b", "circle", "#4ECDC4", "help", nil)
	agents := []*Agent{a1, a2}

	loop := NewLoop(agents, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	if len(loop.agents) != 2 {
		t.Fatalf("len(loop.agents) = %d, want 2", len(loop.agents))
	}
	if loop.agents[0].ID != "agent-1" {
		t.Errorf("loop.agents[0].ID = %q, want %q", loop.agents[0].ID, "agent-1")
	}
}

func TestLoadHistory(t *testing.T) {
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
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
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")

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
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")

	loop.HandlePermissionResponse("nonexistent", true)
}

func TestStop(t *testing.T) {
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	loop.Stop()

	select {
	case <-loop.stopCh:
	default:
		t.Error("stopCh should be closed after Stop()")
	}
}

func TestStopIdempotent(t *testing.T) {
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	loop.Stop()
	loop.Stop()
}

func TestLoopEventsChannel(t *testing.T) {
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxTurns: 5}, "token", "user1", "conv1")
	events := loop.Events()
	if events == nil {
		t.Fatal("Events() returned nil channel")
	}
}

func TestRunNoAgents(t *testing.T) {
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxTurns: 5, TurnTimeout: time.Second}, "token", "user1", "conv1")

	done := make(chan struct{})
	go func() {
		defer close(done)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		loop.MarkConsumerReady()
		loop.Run(ctx, "test message")
	}()

	var gotError bool
	for evt := range loop.Events() {
		if evt.Type == EventError {
			gotError = true
		}
	}
	<-done
	if !gotError {
		t.Error("expected error event when no agents are configured")
	}
}

func TestRunSingleAgentNoProvider(t *testing.T) {
	agent := NewAgent("agent-1", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop([]*Agent{agent}, nil, nil, nil, LoopConfig{MaxTurns: 5, TurnTimeout: time.Second}, "token", "user1", "conv1")

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
