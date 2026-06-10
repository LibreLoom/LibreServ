package agent

import (
	"encoding/json"
	"testing"
)

func TestDeliberationEventTypes(t *testing.T) {
	if EventAgentThinking != "agent_thinking" {
		t.Errorf("EventAgentThinking = %q, want %q", EventAgentThinking, "agent_thinking")
	}
	if EventAgentMessage != "agent_message" {
		t.Errorf("EventAgentMessage = %q, want %q", EventAgentMessage, "agent_message")
	}
	if EventProposal != "proposal" {
		t.Errorf("EventProposal = %q, want %q", EventProposal, "proposal")
	}
	if EventVote != "vote" {
		t.Errorf("EventVote = %q, want %q", EventVote, "vote")
	}
	if EventConsensus != "consensus" {
		t.Errorf("EventConsensus = %q, want %q", EventConsensus, "consensus")
	}
}

func TestAgentThinkingData(t *testing.T) {
	data := AgentThinkingData{
		AgentID:     "agent-1",
		AvatarShape: "diamond",
		AvatarColor: "#FF6B35",
		Model:       "route/mimo-v2.5-pro",
	}
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal AgentThinkingData: %v", err)
	}
	var parsed AgentThinkingData
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal AgentThinkingData: %v", err)
	}
	if parsed.AgentID != "agent-1" {
		t.Errorf("AgentID = %q, want %q", parsed.AgentID, "agent-1")
	}
	if parsed.AvatarShape != "diamond" {
		t.Errorf("AvatarShape = %q, want %q", parsed.AvatarShape, "diamond")
	}
}

func TestAgentMessageData(t *testing.T) {
	data := AgentMessageData{
		AgentID:     "agent-2",
		AvatarShape: "circle",
		AvatarColor: "#4ECDC4",
		Content:     "I checked the logs and found an error",
	}
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal AgentMessageData: %v", err)
	}
	var parsed AgentMessageData
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal AgentMessageData: %v", err)
	}
	if parsed.Content != "I checked the logs and found an error" {
		t.Errorf("Content = %q, want original", parsed.Content)
	}
}

func TestToolCallDataWithAgentID(t *testing.T) {
	data := ToolCallData{
		ID:        "call_1",
		Name:      "podman_restart",
		Arguments: json.RawMessage(`{"container":"nginx"}`),
		AgentID:   "agent-1",
	}
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var parsed ToolCallData
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if parsed.AgentID != "agent-1" {
		t.Errorf("AgentID = %q, want %q", parsed.AgentID, "agent-1")
	}
}

func TestConsensusDataRejected(t *testing.T) {
	data := ConsensusData{
		ProposalID: "prop-1",
		Result:     "rejected",
		Votes: []VoteData{
			{AgentID: "agent-2", Decision: "reject", Reason: "too risky"},
		},
	}
	if data.Result != "rejected" {
		t.Errorf("Result = %q, want %q", data.Result, "rejected")
	}
	if len(data.Votes) != 1 {
		t.Errorf("len(Votes) = %d, want 1", len(data.Votes))
	}
}
