package agent

import "encoding/json"

type EventType string

const (
	EventTurnStart         EventType = "turn_start"
	EventAgentThinking     EventType = "agent_thinking"
	EventAgentMessage      EventType = "agent_message"
	EventToolCall          EventType = "tool_call"
	EventToolResult        EventType = "tool_result"
	EventProposal          EventType = "proposal"
	EventVote              EventType = "vote"
	EventConsensus         EventType = "consensus"
	EventPermissionRequest EventType = "permission_request"
	EventSnapshotCreated   EventType = "snapshot_created"
	EventUsageUpdate       EventType = "usage_update"
	EventAgentResponse     EventType = "agent_response"
	EventDone              EventType = "done"
	EventError             EventType = "error"
)

type Event struct {
	Type EventType   `json:"type"`
	Data interface{} `json:"data"`
}

func (e Event) MarshalJSON() ([]byte, error) {
	type Alias Event
	return json.Marshal(&struct{ Alias }{Alias: Alias(e)})
}

type TurnStartData struct {
	Turn int `json:"turn"`
}

type AgentThinkingData struct {
	AgentID     string `json:"agent_id"`
	AvatarShape string `json:"avatar_shape"`
	AvatarColor string `json:"avatar_color"`
	Model       string `json:"model"`
}

type AgentMessageData struct {
	AgentID     string `json:"agent_id"`
	AvatarShape string `json:"avatar_shape"`
	AvatarColor string `json:"avatar_color"`
	Content     string `json:"content"`
}

type ToolCallData struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	AgentID   string          `json:"agent_id,omitempty"`
}

type ToolResultData struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	IsError bool   `json:"is_error"`
	AgentID string `json:"agent_id,omitempty"`
}

type PermissionRequestData struct {
	ID        string `json:"id"`
	ToolName  string `json:"tool_name"`
	Reason    string `json:"reason"`
	Resource  string `json:"resource"`
	GrantType string `json:"grant_type"`
	AgentID   string `json:"agent_id,omitempty"`
}

type PermissionResponseData struct {
	ID       string `json:"id"`
	Approved bool   `json:"approved"`
}

type SnapshotCreatedData struct {
	SnapshotID string `json:"snapshot_id"`
	ToolCallID string `json:"tool_call_id"`
}

type UsageUpdateData struct {
	TurnCostUSD  float64 `json:"turn_cost_usd"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	CacheTokens  int     `json:"cache_tokens"`
	RemainingUSD float64 `json:"remaining_usd"`
}

type AgentResponseData struct {
	Content string `json:"content"`
}

type DoneData struct {
	Reason string `json:"reason"`
}

type ErrorData struct {
	Message string `json:"message"`
}

type ProposalData struct {
	ID        string         `json:"id"`
	AgentID   string         `json:"agent_id"`
	Type      string         `json:"type"`
	ToolCalls []ToolCallData `json:"tool_calls,omitempty"`
	Response  string         `json:"response,omitempty"`
}

type VoteData struct {
	ProposalID  string `json:"proposal_id"`
	AgentID     string `json:"agent_id"`
	AvatarShape string `json:"avatar_shape"`
	AvatarColor string `json:"avatar_color"`
	Decision    string `json:"decision"`
	Reason      string `json:"reason"`
}

type ConsensusData struct {
	ProposalID string     `json:"proposal_id"`
	Result     string     `json:"result"`
	Votes      []VoteData `json:"votes"`
}
