package config

import (
	"strings"
	"testing"
)

func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}

func TestDefaultAgents(t *testing.T) {
	agents := DefaultAgents()
	if len(agents) != 3 {
		t.Fatalf("DefaultAgents returned %d, want 3", len(agents))
	}

	ids := map[string]bool{}
	for _, a := range agents {
		ids[a.ID] = true
	}
	if !ids["agent-1"] {
		t.Error("missing 'agent-1' agent")
	}
	if !ids["agent-2"] {
		t.Error("missing 'agent-2' agent")
	}
	if !ids["self-healing"] {
		t.Error("missing 'self-healing' agent")
	}
}

func TestDefaultAgent1(t *testing.T) {
	agents := DefaultAgents()
	var a1 *AgentDefinition
	for i := range agents {
		if agents[i].ID == "agent-1" {
			a1 = &agents[i]
			break
		}
	}
	if a1 == nil {
		t.Fatal("agent-1 not found")
	}
	if a1.Trigger != "chat" {
		t.Errorf("agent-1.Trigger = %q, want %q", a1.Trigger, "chat")
	}
	if a1.Model != "" {
		t.Errorf("agent-1.Model = %q, want empty (resolves to default_model at runtime)", a1.Model)
	}
	if a1.AvatarShape != "diamond" {
		t.Errorf("agent-1.AvatarShape = %q, want %q", a1.AvatarShape, "diamond")
	}
	if a1.AvatarColor != "#FF6B35" {
		t.Errorf("agent-1.AvatarColor = %q, want %q", a1.AvatarColor, "#FF6B35")
	}
	if a1.SystemPrompt == "" {
		t.Error("agent-1.SystemPrompt should not be empty — agents need distinct roles")
	}
	if !contains(a1.SystemPrompt, "Research") {
		t.Error("agent-1.SystemPrompt should identify as Research Agent")
	}
}

func TestDefaultAgent2(t *testing.T) {
	agents := DefaultAgents()
	var a2 *AgentDefinition
	for i := range agents {
		if agents[i].ID == "agent-2" {
			a2 = &agents[i]
			break
		}
	}
	if a2 == nil {
		t.Fatal("agent-2 not found")
	}
	if a2.Model != "" {
		t.Errorf("agent-2.Model = %q, want empty (resolves to default_model at runtime)", a2.Model)
	}
	if a2.AvatarShape != "circle" {
		t.Errorf("agent-2.AvatarShape = %q, want %q", a2.AvatarShape, "circle")
	}
	if a2.SystemPrompt == "" {
		t.Error("agent-2.SystemPrompt should not be empty — agents need distinct roles")
	}
	if !contains(a2.SystemPrompt, "Review") {
		t.Error("agent-2.SystemPrompt should identify as Review & Safety Agent")
	}
}

func TestDefaultSelfHealingAgent(t *testing.T) {
	agents := DefaultAgents()
	var sh *AgentDefinition
	for i := range agents {
		if agents[i].ID == "self-healing" {
			sh = &agents[i]
			break
		}
	}
	if sh == nil {
		t.Fatal("self-healing agent not found")
	}
	if sh.Trigger != "container_unhealthy" {
		t.Errorf("self-healing.Trigger = %q, want %q", sh.Trigger, "container_unhealthy")
	}
	if sh.MaxTurns != 5 {
		t.Errorf("self-healing.MaxTurns = %d, want 5", sh.MaxTurns)
	}
	if sh.PermissionMode != "auto" {
		t.Errorf("self-healing.PermissionMode = %q, want %q", sh.PermissionMode, "auto")
	}
}

func TestAgentByID(t *testing.T) {
	orig := globalConfig
	globalConfig = &Config{Support: SupportConfig{}}
	defer func() { globalConfig = orig }()

	agent := AgentByID("agent-1")
	if agent == nil {
		t.Fatal("AgentByID('agent-1') should find default agent")
	}
	if agent.ID != "agent-1" {
		t.Errorf("AgentByID('agent-1').ID = %q, want %q", agent.ID, "agent-1")
	}
}

func TestAgentByIDNonexistent(t *testing.T) {
	orig := globalConfig
	globalConfig = &Config{Support: SupportConfig{}}
	defer func() { globalConfig = orig }()

	agent := AgentByID("nonexistent")
	if agent != nil {
		t.Error("AgentByID should return nil for nonexistent ID")
	}
}

func TestAgentsByTrigger(t *testing.T) {
	orig := globalConfig
	globalConfig = &Config{Support: SupportConfig{}}
	defer func() { globalConfig = orig }()

	agents := AgentsByTrigger("chat")
	if len(agents) != 2 {
		t.Fatalf("AgentsByTrigger('chat') = %d, want 2", len(agents))
	}
}

func TestAgentsByTriggerNoMatch(t *testing.T) {
	orig := globalConfig
	globalConfig = &Config{Support: SupportConfig{}}
	defer func() { globalConfig = orig }()

	agents := AgentsByTrigger("nonexistent")
	if len(agents) != 0 {
		t.Errorf("AgentsByTrigger('nonexistent') = %d, want 0", len(agents))
	}
}

func TestAgentDefinitionCustomConfig(t *testing.T) {
	orig := globalConfig
	globalConfig = &Config{
		Support: SupportConfig{
			Agents: []AgentDefinition{
				{ID: "custom", Trigger: "webhook", Model: "route/deepseek-v4-pro", ToolNames: []string{"docker"}, MaxTurns: 3},
			},
		},
	}
	defer func() { globalConfig = orig }()

	agent := AgentByID("custom")
	if agent == nil {
		t.Fatal("AgentByID('custom') should find custom agent")
	}
	if agent.Model != "route/deepseek-v4-pro" {
		t.Errorf("custom.Model = %q, want %q", agent.Model, "route/deepseek-v4-pro")
	}
}

func TestDefaultAgentsHaveDistinctRoles(t *testing.T) {
	agents := DefaultAgents()
	var a1, a2 *AgentDefinition
	for i := range agents {
		switch agents[i].ID {
		case "agent-1":
			a1 = &agents[i]
		case "agent-2":
			a2 = &agents[i]
		}
	}
	if a1 == nil || a2 == nil {
		t.Fatal("missing agent-1 or agent-2")
	}
	if a1.SystemPrompt == a2.SystemPrompt {
		t.Error("agent-1 and agent-2 must have distinct SystemPrompts — identical prompts create an echo chamber that wastes tokens")
	}
}

func TestAgentDefinitionAvatarFields(t *testing.T) {
	a := AgentDefinition{
		ID:          "test",
		AvatarShape: "hexagon",
		AvatarColor: "#45B7D1",
	}
	if a.AvatarShape != "hexagon" {
		t.Errorf("AvatarShape = %q, want %q", a.AvatarShape, "hexagon")
	}
	if a.AvatarColor != "#45B7D1" {
		t.Errorf("AvatarColor = %q, want %q", a.AvatarColor, "#45B7D1")
	}
}
