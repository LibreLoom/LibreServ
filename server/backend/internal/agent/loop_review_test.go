package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/tools"
)

func TestNewLoopWithMultipleAgents(t *testing.T) {
	a1 := NewAgent("agent-1", "route/mimo-v2.5-pro", "diamond", "#FF6B35", "help users", nil)
	a2 := NewAgent("agent-2", "route/kimi-k2.6", "circle", "#4ECDC4", "help users", nil)
	registry := tools.NewRegistry()

	loop := NewLoop([]*Agent{a1, a2}, registry, nil, nil, LoopConfig{MaxTurns: 10}, "token", "user1", "conv1")
	if loop == nil {
		t.Fatal("NewLoop returned nil")
	}
	if len(loop.agents) != 2 {
		t.Errorf("len(loop.agents) = %d, want 2", len(loop.agents))
	}
}

func TestLoopConfigMaxContextMessages(t *testing.T) {
	cfg := LoopConfig{
		MaxTurns:           20,
		MaxContextMessages: 80,
	}
	if cfg.MaxContextMessages != 80 {
		t.Errorf("MaxContextMessages = %d, want 80", cfg.MaxContextMessages)
	}
}

func TestSummarizeOldMessagesNoAgents(t *testing.T) {
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxContextMessages: 10}, "token", "user1", "conv1")
	msgs := []Message{
		{Role: RoleUser, Content: "hello"},
		{Role: RoleAssistant, Content: "hi"},
		{Role: RoleUser, Content: "how are you?"},
	}
	result, err := loop.summarizeOldMessages(context.Background(), msgs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != len(msgs) {
		t.Errorf("without agents, should return original messages; got %d, want %d", len(result), len(msgs))
	}
}

func TestSummarizeOldMessagesBelowThreshold(t *testing.T) {
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{MaxContextMessages: 20}, "token", "user1", "conv1")
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

func TestSummarizeOldMessagesNoProvider(t *testing.T) {
	a := NewAgent("test", "test-model", "diamond", "#FF6B35", "help", nil)
	loop := NewLoop([]*Agent{a}, nil, nil, nil, LoopConfig{MaxContextMessages: 4}, "token", "user1", "conv1")

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

func TestBuildVotingPrompt(t *testing.T) {
	loop := NewLoop(nil, nil, nil, nil, LoopConfig{}, "token", "user1", "conv1")
	prompt := loop.buildVotingPrompt()
	if prompt == "" {
		t.Fatal("buildVotingPrompt returned empty string")
	}
	if !strings.Contains(prompt, "multi-agent") {
		t.Error("voting prompt missing 'multi-agent'")
	}
	if !strings.Contains(prompt, "cast_vote") {
		t.Error("voting prompt missing tool name reference")
	}
}

func TestProposalDataSerialization(t *testing.T) {
	data := ProposalData{
		ID:      "prop-1",
		AgentID: "agent-1",
		Type:    "write",
		ToolCalls: []ToolCallData{
			{ID: "call_1", Name: "docker_restart", Arguments: json.RawMessage(`{"container":"nginx"}`), AgentID: "agent-1"},
		},
	}
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal ProposalData: %v", err)
	}
	var parsed ProposalData
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal ProposalData: %v", err)
	}
	if parsed.Type != "write" {
		t.Errorf("Type = %q, want %q", parsed.Type, "write")
	}
	if len(parsed.ToolCalls) != 1 {
		t.Errorf("len(ToolCalls) = %d, want 1", len(parsed.ToolCalls))
	}
}

func TestVoteDataSerialization(t *testing.T) {
	data := VoteData{
		ProposalID:  "prop-1",
		AgentID:     "agent-2",
		AvatarShape: "circle",
		AvatarColor: "#4ECDC4",
		Decision:    "approve",
		Reason:      "looks safe",
	}
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal VoteData: %v", err)
	}
	var parsed VoteData
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal VoteData: %v", err)
	}
	if parsed.Decision != "approve" {
		t.Errorf("Decision = %q, want %q", parsed.Decision, "approve")
	}
	if parsed.AvatarShape != "circle" {
		t.Errorf("AvatarShape = %q, want %q", parsed.AvatarShape, "circle")
	}
}

func TestConsensusDataSerialization(t *testing.T) {
	data := ConsensusData{
		ProposalID: "prop-1",
		Result:     "approved",
		Votes: []VoteData{
			{AgentID: "agent-2", Decision: "approve", Reason: "safe"},
		},
	}
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal ConsensusData: %v", err)
	}
	var parsed ConsensusData
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal ConsensusData: %v", err)
	}
	if parsed.Result != "approved" {
		t.Errorf("Result = %q, want %q", parsed.Result, "approved")
	}
	if len(parsed.Votes) != 1 {
		t.Errorf("len(Votes) = %d, want 1", len(parsed.Votes))
	}
}

func TestTruncate(t *testing.T) {
	if truncate("hello", 10) != "hello" {
		t.Error("truncate should return original if under maxLen")
	}
	if truncate("hello world", 5) != "hello..." {
		t.Errorf("truncate('hello world', 5) = %q, want %q", truncate("hello world", 5), "hello...")
	}
}
