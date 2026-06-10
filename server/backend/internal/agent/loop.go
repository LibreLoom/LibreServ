package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/tools"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/subscription"
)

type MessageRole string

const (
	RoleSystem    MessageRole = "system"
	RoleUser      MessageRole = "user"
	RoleAssistant MessageRole = "assistant"
	RoleTool      MessageRole = "tool"
)

type Message struct {
	Role       MessageRole       `json:"role"`
	Content    string            `json:"content,omitempty"`
	ToolCalls  []ToolCallMessage `json:"tool_calls,omitempty"`
	ToolCallID string            `json:"tool_call_id,omitempty"`
	AgentID    string            `json:"agent_id,omitempty"`
}

type ToolCallMessage struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type LoopConfig struct {
	MaxTurns             int
	TurnTimeout          time.Duration
	PermissionMode       string
	SnapshotBeforeWrites bool
	MaxContextMessages   int
}

type proposal struct {
	id        string
	agentID   string
	propType  string
	toolCalls []AgentToolCall
	response  string
}

type agentResult struct {
	agentID     string
	avatarShape string
	avatarColor string
	content     string
	toolCalls   []AgentToolCall
	usage       *UsageInfo
	err         error
}

type Loop struct {
	agents      []*Agent
	registry    *tools.Registry
	credits     *subscription.CreditService
	plan        *subscription.Plan
	config      LoopConfig
	billingMode string
	messages    []Message
	turnCount   int
	totalCost   float64
	userID      string
	convID      string

	events   chan Event
	stopCh   chan struct{}
	stopOnce sync.Once
	// mu was removed — field was unused (U1000)
	consumerReady chan struct{}
	readyOnce     sync.Once

	pendingPerm   map[string]chan bool
	pendingPermMu sync.Mutex
}

func NewLoop(agents []*Agent, registry *tools.Registry, credits *subscription.CreditService, plan *subscription.Plan, config LoopConfig, billingMode, userID, convID string) *Loop {
	return &Loop{
		agents:        agents,
		registry:      registry,
		credits:       credits,
		plan:          plan,
		config:        config,
		billingMode:   billingMode,
		userID:        userID,
		convID:        convID,
		events:        make(chan Event, 256),
		stopCh:        make(chan struct{}),
		consumerReady: make(chan struct{}),
		pendingPerm:   make(map[string]chan bool),
	}
}

func (l *Loop) Events() <-chan Event {
	return l.events
}

func (l *Loop) MarkConsumerReady() {
	l.readyOnce.Do(func() {
		close(l.consumerReady)
	})
}

func (l *Loop) LoadHistory(msgs []Message) {
	l.messages = append(l.messages[:0], msgs...)
}

func (l *Loop) Stop() {
	l.stopOnce.Do(func() {
		close(l.stopCh)
	})
}

func (l *Loop) Run(ctx context.Context, userMessage string) {
	defer close(l.events)

	select {
	case <-l.consumerReady:
	case <-l.stopCh:
		l.emitDone("user_stopped")
		return
	case <-ctx.Done():
		l.emitDone("context_cancelled")
		return
	case <-time.After(30 * time.Second):
		l.emitDone("no_consumer")
		return
	}

	l.messages = append(l.messages, Message{Role: RoleUser, Content: userMessage})

	for l.turnCount < l.config.MaxTurns {
		select {
		case <-l.stopCh:
			l.emitDone("user_stopped")
			return
		case <-ctx.Done():
			l.emitDone("context_cancelled")
			return
		default:
		}

		l.turnCount++
		l.emit(Event{Type: EventTurnStart, Data: TurnStartData{Turn: l.turnCount}})

		if len(l.agents) == 0 {
			l.emit(Event{Type: EventError, Data: ErrorData{Message: "no agents configured"}})
			l.emitDone("error")
			return
		}

		results := l.runAgentsConcurrently(ctx)

		proposals := l.processAgentResults(ctx, results)

		if len(proposals) > 0 {
			finished := l.handleProposals(ctx, proposals)
			if finished {
				return
			}
		}

		anyActivity := false
		for _, r := range results {
			if r.err == nil && (len(r.toolCalls) > 0 || r.content != "") {
				anyActivity = true
				break
			}
		}
		if !anyActivity && len(proposals) == 0 {
			l.emitDone("complete")
			return
		}
	}

	l.emitDone("max_turns")
}

func (l *Loop) runAgentsConcurrently(ctx context.Context) []agentResult {
	for _, a := range l.agents {
		l.emit(Event{Type: EventAgentThinking, Data: AgentThinkingData{
			AgentID:     a.ID,
			AvatarShape: a.AvatarShape,
			AvatarColor: a.AvatarColor,
			Model:       a.Model,
		}})
	}

	results := make([]agentResult, len(l.agents))
	var wg sync.WaitGroup

	for i, a := range l.agents {
		wg.Add(1)
		go func(idx int, agent *Agent) {
			defer wg.Done()

			callCtx, cancel := context.WithTimeout(ctx, l.config.TurnTimeout)
			defer cancel()

			msgs := l.buildAgentMessages()
			if l.config.MaxContextMessages > 0 && len(msgs) > l.config.MaxContextMessages {
				summarized, err := l.summarizeOldMessages(callCtx, msgs)
				if err != nil {
					results[idx] = agentResult{agentID: agent.ID, avatarShape: agent.AvatarShape, avatarColor: agent.AvatarColor, err: err}
					return
				}
				msgs = summarized
			}

			resp, usage, err := agent.Call(callCtx, msgs, l.registry.ToolDefinitions())

			r := agentResult{
				agentID:     agent.ID,
				avatarShape: agent.AvatarShape,
				avatarColor: agent.AvatarColor,
			}
			if err != nil {
				r.err = err
			} else {
				r.content = resp.Content
				r.toolCalls = resp.ToolCalls
				r.usage = usage
			}
			results[idx] = r
		}(i, a)
	}

	wg.Wait()
	return results
}

func (l *Loop) buildAgentMessages() []Message {
	msgs := make([]Message, 0, len(l.messages))
	msgs = append(msgs, l.messages...)
	return msgs
}

func (l *Loop) processAgentResults(ctx context.Context, results []agentResult) []proposal {
	var proposals []proposal
	var sharedUpdates []Message

	for _, r := range results {
		if r.err != nil {
			l.emit(Event{Type: EventError, Data: ErrorData{Message: fmt.Sprintf("agent %s: %s", r.agentID, r.err.Error())}})
			continue
		}

		if r.usage != nil {
			l.totalCost += r.usage.CostUSD
			if err := l.deductCredits(ctx, l.agentModel(r.agentID), r.usage); err != nil {
				if err == subscription.ErrCreditExceeded {
					l.emitDone("credits_exceeded")
					return nil
				}
			}
			l.emitUsageUpdate(r.agentID, r.usage)
		}

		if r.content != "" {
			l.emit(Event{Type: EventAgentMessage, Data: AgentMessageData{
				AgentID:     r.agentID,
				AvatarShape: r.avatarShape,
				AvatarColor: r.avatarColor,
				Content:     r.content,
			}})
		}

		var readCalls, writeCalls []AgentToolCall
		for _, tc := range r.toolCalls {
			tool, ok := l.registry.Get(tc.Name)
			if !ok {
				l.emitToolCall(r.agentID, tc)
				resultContent := fmt.Sprintf("unknown tool: %s", tc.Name)
				l.emitToolResult(r.agentID, tc.ID, resultContent, true)
				sharedUpdates = append(sharedUpdates, Message{
					Role:    RoleSystem,
					AgentID: r.agentID,
					Content: fmt.Sprintf("[Agent %s] Called %s — unknown tool", r.agentID, tc.Name),
				})
				continue
			}
			if tool.IsResearch {
				readCalls = append(readCalls, tc)
			} else {
				writeCalls = append(writeCalls, tc)
			}
		}

		for _, tc := range readCalls {
			l.emitToolCall(r.agentID, tc)
			result, toolErr := l.executeTool(ctx, r.agentID, tc)
			isErr := toolErr != nil
			resultContent := result
			if toolErr != nil {
				resultContent = toolErr.Error()
			}
			l.emitToolResult(r.agentID, tc.ID, resultContent, isErr)
			sharedUpdates = append(sharedUpdates, Message{
				Role:    RoleSystem,
				AgentID: r.agentID,
				Content: fmt.Sprintf("[Agent %s] Called %s — Result: %s", r.agentID, tc.Name, truncate(resultContent, 500)),
			})
		}

		if len(writeCalls) > 0 {
			proposals = append(proposals, proposal{
				id:        generateProposalID(),
				agentID:   r.agentID,
				propType:  "write",
				toolCalls: writeCalls,
			})
		}

		if len(r.toolCalls) == 0 && r.content != "" {
			proposals = append(proposals, proposal{
				id:       generateProposalID(),
				agentID:  r.agentID,
				propType: "final_response",
				response: r.content,
			})
		}
	}

	l.messages = append(l.messages, sharedUpdates...)
	return proposals
}

func (l *Loop) handleProposals(ctx context.Context, proposals []proposal) bool {
	writeFirst := make([]proposal, 0, len(proposals))
	var finalResp *proposal
	for _, p := range proposals {
		if p.propType == "final_response" {
			if finalResp == nil {
				p2 := p
				finalResp = &p2
			}
		} else {
			writeFirst = append(writeFirst, p)
		}
	}

	for _, prop := range writeFirst {
		select {
		case <-l.stopCh:
			l.emitDone("user_stopped")
			return true
		case <-ctx.Done():
			l.emitDone("context_cancelled")
			return true
		default:
		}

		approved := l.runConsensus(ctx, &prop)
		if approved {
			for _, tc := range prop.toolCalls {
				l.emitToolCall(prop.agentID, tc)
				result, toolErr := l.executeWriteTool(ctx, prop.agentID, tc)
				isErr := toolErr != nil
				resultContent := result
				if toolErr != nil {
					resultContent = toolErr.Error()
				}
				l.emitToolResult(prop.agentID, tc.ID, resultContent, isErr)
				l.messages = append(l.messages, Message{
					Role:    RoleSystem,
					AgentID: prop.agentID,
					Content: fmt.Sprintf("[Consensus Approved] Agent %s executed %s — Result: %s", prop.agentID, tc.Name, truncate(resultContent, 500)),
				})
			}
		} else {
			l.messages = append(l.messages, Message{
				Role:    RoleSystem,
				Content: fmt.Sprintf("[Consensus Rejected] Proposal by Agent %s was rejected. Agents should revise their approach.", prop.agentID),
			})
		}
	}

	if finalResp != nil {
		approved := l.runConsensus(ctx, finalResp)
		if approved {
			l.emit(Event{Type: EventAgentResponse, Data: AgentResponseData{Content: finalResp.response}})
			l.emitDone("complete")
			return true
		}
		l.messages = append(l.messages, Message{
			Role:    RoleSystem,
			Content: fmt.Sprintf("[Consensus Rejected] Final response by Agent %s was rejected. Agents should revise their response.", finalResp.agentID),
		})
	}

	return false
}

func (l *Loop) runConsensus(ctx context.Context, prop *proposal) bool {
	pd := ProposalData{
		ID:       prop.id,
		AgentID:  prop.agentID,
		Type:     prop.propType,
		Response: prop.response,
	}
	for _, tc := range prop.toolCalls {
		pd.ToolCalls = append(pd.ToolCalls, ToolCallData{
			ID:        tc.ID,
			Name:      tc.Name,
			Arguments: tc.Arguments,
			AgentID:   prop.agentID,
		})
	}
	l.emit(Event{Type: EventProposal, Data: pd})

	if len(l.agents) <= 1 {
		l.emit(Event{Type: EventConsensus, Data: ConsensusData{
			ProposalID: prop.id,
			Result:     "approved",
			Votes:      nil,
		}})
		return true
	}

	var votes []VoteData
	for _, agent := range l.agents {
		if agent.ID == prop.agentID {
			continue
		}

		vote := l.getVote(ctx, agent, prop)
		votes = append(votes, vote)
		l.emit(Event{Type: EventVote, Data: vote})
	}

	allApproved := true
	for _, v := range votes {
		if v.Decision == "reject" {
			allApproved = false
			l.messages = append(l.messages, Message{
				Role:    RoleSystem,
				Content: fmt.Sprintf("Agent %s rejected: %s", v.AgentID, v.Reason),
			})
			break
		}
	}

	result := "approved"
	if !allApproved {
		result = "rejected"
	}
	l.emit(Event{Type: EventConsensus, Data: ConsensusData{
		ProposalID: prop.id,
		Result:     result,
		Votes:      votes,
	}})

	return allApproved
}

func (l *Loop) getVote(ctx context.Context, agent *Agent, prop *proposal) VoteData {
	var proposalDesc string
	if prop.propType == "write" {
		var parts []string
		for _, tc := range prop.toolCalls {
			parts = append(parts, fmt.Sprintf("%s(%s)", tc.Name, string(tc.Arguments)))
		}
		proposalDesc = fmt.Sprintf("Agent %s proposes to execute: %s", prop.agentID, strings.Join(parts, ", "))
	} else {
		proposalDesc = fmt.Sprintf("Agent %s proposes this response to the user:\n\n%s", prop.agentID, prop.response)
	}

	voteDefs := []map[string]interface{}{
		{
			"type": "function",
			"function": map[string]interface{}{
				"name":        "cast_vote",
				"description": "Cast your vote on this proposal. You must call this function.",
				"parameters": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"decision": map[string]interface{}{
							"type":        "string",
							"enum":        []string{"approve", "reject"},
							"description": "Your vote: approve if the proposal is safe and appropriate, reject if there are concerns",
						},
						"reason": map[string]interface{}{
							"type":        "string",
							"description": "Brief explanation of your vote",
						},
					},
					"required": []string{"decision", "reason"},
				},
			},
		},
	}

	voteMsgs := []Message{
		{Role: RoleSystem, Content: l.buildVotingPrompt()},
		{Role: RoleUser, Content: proposalDesc},
	}

	callCtx, cancel := context.WithTimeout(ctx, l.config.TurnTimeout)
	defer cancel()

	resp, usage, err := agent.Call(callCtx, voteMsgs, voteDefs)

	if usage != nil {
		l.totalCost += usage.CostUSD
		_ = l.deductCredits(callCtx, agent.Model, usage)
		l.emitUsageUpdate(agent.ID, usage)
	}

	decision := "reject"
	reason := ""
	if err != nil {
		decision = "reject"
		reason = "voting call failed, defaulting to reject for safety"
	} else if len(resp.ToolCalls) > 0 {
		for _, tc := range resp.ToolCalls {
			if tc.Name != "cast_vote" {
				continue
			}
			var v struct {
				Decision string `json:"decision"`
				Reason   string `json:"reason"`
			}
			if err := json.Unmarshal(tc.Arguments, &v); err == nil {
				decision = v.Decision
				reason = v.Reason
			}
		}
	}

	return VoteData{
		ProposalID:  prop.id,
		AgentID:     agent.ID,
		AvatarShape: agent.AvatarShape,
		AvatarColor: agent.AvatarColor,
		Decision:    decision,
		Reason:      reason,
	}
}

func (l *Loop) buildVotingPrompt() string {
	return `You are an agent in a multi-agent support team managing a home server. Another agent has proposed an action. Your job is to review the proposal and decide whether it is safe and appropriate.

Guidelines:
- Read-only operations (listing containers, reading logs, checking health) should generally be approved.
- Write operations (restarting containers, writing files) are acceptable if they seem reasonable for the user's request and a snapshot was created before the change.
- Destructive operations (deleting data, removing containers without backup) should be rejected unless clearly justified.
- Final responses should be approved if they are accurate, helpful, and written in plain language without technical jargon.
- If you have concerns about the approach, reject and explain what should be done differently.

You MUST call cast_vote with your decision.`
}

func (l *Loop) executeTool(ctx context.Context, agentID string, tc AgentToolCall) (string, error) {
	tool, ok := l.registry.Get(tc.Name)
	if !ok {
		return "", fmt.Errorf("unknown tool: %s", tc.Name)
	}

	if tool.RequiresPermission || l.config.PermissionMode == "approve_every_call" {
		grantType := "tool_call"
		resource := tc.Name
		if tool.RequiresPermission {
			grantType = "sensitive_access"
		}
		permCh := make(chan bool, 1)
		l.pendingPermMu.Lock()
		l.pendingPerm[tc.ID] = permCh
		l.pendingPermMu.Unlock()
		defer func() {
			l.pendingPermMu.Lock()
			delete(l.pendingPerm, tc.ID)
			l.pendingPermMu.Unlock()
		}()

		l.emit(Event{Type: EventPermissionRequest, Data: PermissionRequestData{
			ID:        tc.ID,
			ToolName:  tc.Name,
			Reason:    tool.Description,
			Resource:  resource,
			GrantType: grantType,
			AgentID:   agentID,
		}})
		select {
		case approved := <-permCh:
			if !approved {
				return "", fmt.Errorf("user denied permission for %s", tc.Name)
			}
		case <-l.stopCh:
			return "", fmt.Errorf("stopped while waiting for permission")
		case <-ctx.Done():
			return "", fmt.Errorf("context cancelled while waiting for permission")
		case <-time.After(l.config.TurnTimeout):
			return "", fmt.Errorf("timed out waiting for permission after %v", l.config.TurnTimeout)
		}
	}

	return tool.Execute(ctx, tc.Arguments)
}

func (l *Loop) executeWriteTool(ctx context.Context, agentID string, tc AgentToolCall) (string, error) {
	if l.config.SnapshotBeforeWrites {
		l.emit(Event{Type: EventSnapshotCreated, Data: SnapshotCreatedData{
			ToolCallID: tc.ID,
		}})
	}

	return l.executeTool(ctx, agentID, tc)
}

func (l *Loop) HandlePermissionResponse(id string, approved bool) {
	l.pendingPermMu.Lock()
	ch, ok := l.pendingPerm[id]
	l.pendingPermMu.Unlock()
	if ok {
		select {
		case ch <- approved:
		default:
		}
	}
}

func (l *Loop) summarizeOldMessages(ctx context.Context, msgs []Message) ([]Message, error) {
	if len(l.agents) == 0 {
		return msgs, nil
	}
	var provider *Provider
	var model string
	for _, a := range l.agents {
		if a.provider != nil {
			provider = a.provider
			model = a.Model
			break
		}
	}
	if provider == nil {
		return msgs, nil
	}

	keepRecent := l.config.MaxContextMessages / 2
	if keepRecent < 5 {
		keepRecent = 5
	}
	if len(msgs) <= keepRecent {
		return msgs, nil
	}

	oldMsgs := msgs[:len(msgs)-keepRecent]
	recentMsgs := msgs[len(msgs)-keepRecent:]

	var oldParts []string
	for _, m := range oldMsgs {
		switch m.Role {
		case RoleUser:
			oldParts = append(oldParts, fmt.Sprintf("User: %s", m.Content))
		case RoleAssistant:
			if m.Content != "" {
				oldParts = append(oldParts, fmt.Sprintf("Assistant: %s", m.Content))
			}
			for _, tc := range m.ToolCalls {
				oldParts = append(oldParts, fmt.Sprintf("Assistant called %s", tc.Name))
			}
		case RoleTool:
			content := m.Content
			if len(content) > 200 {
				content = content[:200] + "..."
			}
			oldParts = append(oldParts, fmt.Sprintf("Tool result: %s", content))
		case RoleSystem:
			if m.AgentID != "" {
				oldParts = append(oldParts, fmt.Sprintf("[Agent %s] %s", m.AgentID, m.Content))
			} else {
				oldParts = append(oldParts, m.Content)
			}
		}
	}

	summarizePrompt := fmt.Sprintf(
		"Summarize the following conversation history concisely. Preserve key facts, decisions, and any unresolved issues. Do not include trivial details.\n\n%s",
		strings.Join(oldParts, "\n"),
	)

	sumMsgs := []Message{
		{Role: RoleSystem, Content: "You are a conversation summarizer. Produce a brief, factual summary preserving all key information."},
		{Role: RoleUser, Content: summarizePrompt},
	}

	resp, summaryUsage, err := provider.Chat(ctx, model, sumMsgs, nil)
	if err != nil {
		return msgs, err
	}

	if summaryUsage != nil {
		l.totalCost += summaryUsage.CostUSD
		_ = l.deductCredits(ctx, model, summaryUsage)
	}

	summaryMsg := Message{
		Role:    RoleSystem,
		Content: fmt.Sprintf("Summary of earlier conversation: %s", resp.Content),
	}

	result := make([]Message, 0, len(recentMsgs)+1)
	result = append(result, summaryMsg)
	result = append(result, recentMsgs...)
	return result, nil
}

func (l *Loop) deductCredits(ctx context.Context, model string, usage *UsageInfo) error {
	if l.credits == nil || l.plan == nil || l.plan.CreditCapUSD <= 0 || usage == nil {
		return nil
	}
	if l.billingMode == "request" {
		pricing := l.pricingForModel(model)
		costPerRequest := (pricing.InputPer1M + pricing.OutputPer1M) / 2
		if costPerRequest == 0 {
			costPerRequest = 0.01
		}
		return l.credits.CheckAndDeductRequest(ctx, l.userID, l.convID, model, costPerRequest, l.plan)
	}
	return l.credits.CheckAndDeduct(ctx, l.userID, l.convID, model, usage.InputTokens, usage.OutputTokens, usage.CacheTokens, usage.CostUSD, l.plan)
}

func (l *Loop) pricingForModel(model string) config.ModelPricing {
	cfg := config.Get()
	if cfg == nil {
		return config.ModelPricing{}
	}
	if p, ok := cfg.Support.Pricing[model]; ok {
		return p
	}
	return config.ModelPricing{}
}

func (l *Loop) agentModel(agentID string) string {
	for _, a := range l.agents {
		if a.ID == agentID {
			return a.Model
		}
	}
	return ""
}

func (l *Loop) emitToolCall(agentID string, tc AgentToolCall) {
	l.emit(Event{Type: EventToolCall, Data: ToolCallData{
		ID:        tc.ID,
		Name:      tc.Name,
		Arguments: tc.Arguments,
		AgentID:   agentID,
	}})
}

func (l *Loop) emitToolResult(agentID, id, content string, isError bool) {
	l.emit(Event{Type: EventToolResult, Data: ToolResultData{
		ID:      id,
		Content: content,
		IsError: isError,
		AgentID: agentID,
	}})
}

func (l *Loop) emitUsageUpdate(agentID string, usage *UsageInfo) {
	if l.credits == nil || l.plan == nil || usage == nil {
		return
	}
	usageSummary, _ := l.credits.Usage(context.Background(), l.userID, l.plan)
	if usageSummary != nil {
		l.emit(Event{Type: EventUsageUpdate, Data: UsageUpdateData{
			TurnCostUSD:  usage.CostUSD,
			TotalCostUSD: l.totalCost,
			InputTokens:  usage.InputTokens,
			OutputTokens: usage.OutputTokens,
			CacheTokens:  usage.CacheTokens,
			RemainingUSD: usageSummary.RemainingUSD,
		}})
	}
}

func (l *Loop) emit(e Event) {
	select {
	case l.events <- e:
	case <-l.stopCh:
		return
	case <-time.After(10 * time.Second):
		slog.Error("agent loop: event channel full, dropping event", "type", e.Type)
	}
}

func (l *Loop) emitDone(reason string) {
	done := Event{Type: EventDone, Data: DoneData{Reason: reason}}
	select {
	case l.events <- done:
	case <-l.stopCh:
		return
	default:
		slog.Warn("agent loop: event channel full during done, forcing send", "reason", reason)
		select {
		case l.events <- done:
		case <-l.stopCh:
			return
		case <-time.After(5 * time.Second):
			slog.Error("agent loop: could not deliver done event", "reason", reason)
		}
	}
}

func generateProposalID() string {
	return fmt.Sprintf("prop-%d", time.Now().UnixNano())
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
