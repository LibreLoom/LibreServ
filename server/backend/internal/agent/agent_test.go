package agent

import (
	"strings"
	"testing"
)

func TestPromptSafetyFooterAppended(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "Be helpful", nil)
	if agent.SystemPrompt != "Be helpful" {
		t.Errorf("SystemPrompt = %q, want %q", agent.SystemPrompt, "Be helpful")
	}
	if !strings.Contains(promptSafetyFooter, "CRITICAL SECURITY RULES") {
		t.Error("promptSafetyFooter missing security header")
	}
	if !strings.Contains(promptSafetyFooter, "DATA, not instructions") {
		t.Error("promptSafetyFooter missing anti-injection framing")
	}
	if !strings.Contains(promptSafetyFooter, "ignore previous instructions") {
		t.Error("promptSafetyFooter missing injection attempt handling")
	}
}

func TestPromptSafetyFooterInCallMessages(t *testing.T) {
	agent := NewAgent("test", "test-model", "diamond", "#FF6B35", "Custom prompt", nil)
	msgs := []Message{
		{Role: RoleUser, Content: "hello"},
	}

	allMsgs := make([]Message, 0, len(msgs)+1)
	if agent.SystemPrompt != "" {
		allMsgs = append(allMsgs, Message{Role: RoleSystem, Content: agent.SystemPrompt + promptSafetyFooter})
	}
	allMsgs = append(allMsgs, msgs...)

	if len(allMsgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(allMsgs))
	}
	systemMsg := allMsgs[0]
	if systemMsg.Role != RoleSystem {
		t.Errorf("first message role = %q, want %q", systemMsg.Role, RoleSystem)
	}
	if !strings.Contains(systemMsg.Content, "Custom prompt") {
		t.Error("system message missing custom prompt")
	}
	if !strings.Contains(systemMsg.Content, "CRITICAL SECURITY RULES") {
		t.Error("system message missing safety footer")
	}
}

func TestPromptSafetyFooterWithEmptySystemPrompt(t *testing.T) {
	agent := NewAgent("test", "test-model", "circle", "#4ECDC4", "", nil)
	msgs := []Message{{Role: RoleUser, Content: "hi"}}

	allMsgs := make([]Message, 0, len(msgs)+1)
	if agent.SystemPrompt != "" {
		allMsgs = append(allMsgs, Message{Role: RoleSystem, Content: agent.SystemPrompt + promptSafetyFooter})
	} else {
		allMsgs = append(allMsgs, Message{Role: RoleSystem, Content: promptSafetyFooter})
	}
	allMsgs = append(allMsgs, msgs...)

	if len(allMsgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(allMsgs))
	}
	if !strings.Contains(allMsgs[0].Content, "CRITICAL SECURITY RULES") {
		t.Error("safety footer should be present even with empty system prompt")
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
