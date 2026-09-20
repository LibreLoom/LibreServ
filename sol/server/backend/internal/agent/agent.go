package agent

import (
	"context"
	"encoding/json"
	"fmt"
)

// Agent is a single AI agent that helps users manage their LibreServ server.
type Agent struct {
	ID           string
	Model        string
	AvatarShape  string
	AvatarColor  string
	SystemPrompt string
	provider     *Provider
}

// NewAgent creates an agent with the given configuration.
func NewAgent(id, model, avatarShape, avatarColor, systemPrompt string, provider *Provider) *Agent {
	return &Agent{
		ID:           id,
		Model:        model,
		AvatarShape:  avatarShape,
		AvatarColor:  avatarColor,
		SystemPrompt: systemPrompt,
		provider:     provider,
	}
}

// AgentResponse holds the result of a single agent call.
type AgentResponse struct {
	Content   string
	ToolCalls []AgentToolCall
}

// AgentToolCall is a single tool invocation requested by the agent.
type AgentToolCall struct {
	ID        string
	Name      string
	Arguments json.RawMessage
}

// UsageInfo tracks token usage and cost for a provider call.
type UsageInfo struct {
	InputTokens  int
	OutputTokens int
	CacheTokens  int
	CostUSD      float64
}

// Call invokes the agent's provider with the given messages and tool definitions.
func (a *Agent) Call(ctx context.Context, messages []Message, toolDefs []map[string]interface{}) (*AgentResponse, *UsageInfo, error) {
	if a.provider == nil {
		return nil, nil, fmt.Errorf("no provider configured")
	}

	allMsgs := make([]Message, 0, len(messages)+1)
	if a.SystemPrompt != "" {
		allMsgs = append(allMsgs, Message{Role: RoleSystem, Content: a.SystemPrompt})
	}
	allMsgs = append(allMsgs, messages...)

	return a.provider.Chat(ctx, a.Model, allMsgs, toolDefs)
}
