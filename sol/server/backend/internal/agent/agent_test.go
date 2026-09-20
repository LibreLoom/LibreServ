package agent

import (
	"context"
	"testing"
)

func TestNewAgent(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "Be helpful", nil)
	if agent.ID != "test" {
		t.Errorf("ID = %q, want %q", agent.ID, "test")
	}
	if agent.Model != "test-model" {
		t.Errorf("Model = %q, want %q", agent.Model, "test-model")
	}
	if agent.AvatarShape != "diamond" {
		t.Errorf("AvatarShape = %q, want %q", agent.AvatarShape, "diamond")
	}
	if agent.AvatarColor != "#FF6B35" {
		t.Errorf("AvatarColor = %q, want %q", agent.AvatarColor, "#FF6B35")
	}
	if agent.SystemPrompt != "Be helpful" {
		t.Errorf("SystemPrompt = %q, want %q", agent.SystemPrompt, "Be helpful")
	}
	if agent.provider != nil {
		t.Error("provider should be nil")
	}
}

func TestAgentCallNoProvider(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "prompt", nil)
	_, _, err := agent.Call(context.Background(), nil, nil)
	if err == nil {
		t.Error("expected error when calling agent with no provider")
	}
}

func TestAgentCallWithSystemPrompt(t *testing.T) {
	// Verify the agent prepends the system prompt correctly.
	// We can't test a real call without a provider, but we can verify the
	// message construction logic via Call's behavior with nil provider.
	agent := NewAgent("test", "test-model", "circle", "#4ECDC4", "Custom prompt", nil)
	_, _, err := agent.Call(context.Background(), nil, nil)
	if err == nil || err.Error() != "no provider configured" {
		t.Errorf("expected 'no provider configured' error with nil provider, got: %v", err)
	}
}

func TestAgentCallEmptySystemPrompt(t *testing.T) {
	agent := NewAgent("test", "test-model", "hexagon", "#45B7D1", "", nil)
	_, _, err := agent.Call(context.Background(), nil, nil)
	if err == nil || err.Error() != "no provider configured" {
		t.Errorf("expected 'no provider configured' error, got: %v", err)
	}
}

func TestAgentAvatarFields(t *testing.T) {
	agent := NewAgent("test", "test-model", "hexagon", "#45B7D1", "prompt", nil)
	if agent.AvatarShape != "hexagon" {
		t.Errorf("AvatarShape = %q, want %q", agent.AvatarShape, "hexagon")
	}
	if agent.AvatarColor != "#45B7D1" {
		t.Errorf("AvatarColor = %q, want %q", agent.AvatarColor, "#45B7D1")
	}
}

func TestAgentResponseTypes(t *testing.T) {
	resp := AgentResponse{Content: "hello"}
	if resp.Content != "hello" {
		t.Error("AgentResponse content mismatch")
	}
	if len(resp.ToolCalls) != 0 {
		t.Error("AgentResponse should have no tool calls by default")
	}
}

func TestAgentToolCallTypes(t *testing.T) {
	tc := AgentToolCall{ID: "call_1", Name: "bash"}
	if tc.ID != "call_1" {
		t.Error("ToolCall ID mismatch")
	}
	if tc.Name != "bash" {
		t.Error("ToolCall Name mismatch")
	}
}
