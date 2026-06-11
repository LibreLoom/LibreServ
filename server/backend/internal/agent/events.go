package agent

import "encoding/json"

type EventType string

const (
	EventAgentThinking     EventType = "agent_thinking"
	EventAgentMessage      EventType = "agent_message"
	EventToolCall          EventType = "tool_call"
	EventToolReview        EventType = "tool_review"
	EventPermissionRequest EventType = "permission_request"
	EventToolResult        EventType = "tool_result"
	EventAgentResponse     EventType = "agent_response"
	EventDone              EventType = "done"
	EventError             EventType = "error"
	EventUsageUpdate       EventType = "usage_update"
)

type Event struct {
	Type EventType   `json:"type"`
	Data interface{} `json:"data"`
}

func (e Event) MarshalJSON() ([]byte, error) {
	type Alias Event
	return json.Marshal(&struct{ Alias }{Alias: Alias(e)})
}

// --- Event Data Types ---

type AgentThinkingData struct {
	Model       string `json:"model"`
	AvatarShape string `json:"avatar_shape"`
	AvatarColor string `json:"avatar_color"`
}

type AgentMessageData struct {
	Content string `json:"content"`
}

type ToolCallData struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type ToolReviewData struct {
	ToolCallID string `json:"tool_call_id"`
	ToolName   string `json:"tool_name"`
	Verdict    string `json:"verdict"`
	Reason     string `json:"reason"`
}

type PermissionRequestData struct {
	ID       string `json:"id"`
	ToolName string `json:"tool_name"`
	Reason   string `json:"reason"`
}

type ToolResultData struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	IsError bool   `json:"is_error"`
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

type UsageUpdateData struct {
	TurnCostUSD  float64 `json:"turn_cost_usd"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	CacheTokens  int     `json:"cache_tokens"`
	RemainingUSD float64 `json:"remaining_usd"`
}
