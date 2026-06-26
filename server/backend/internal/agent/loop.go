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

// MessageRole classifies a message in the agent conversation.
type MessageRole string

const (
	RoleSystem    MessageRole = "system"
	RoleUser      MessageRole = "user"
	RoleAssistant MessageRole = "assistant"
	RoleTool      MessageRole = "tool"
)

// Message is a single entry in the conversation.
type Message struct {
	Role       MessageRole       `json:"role"`
	Content    string            `json:"content,omitempty"`
	ToolCalls  []ToolCallMessage `json:"tool_calls,omitempty"`
	ToolCallID string            `json:"tool_call_id,omitempty"`
}

// ToolCallMessage represents a tool call in an assistant message.
type ToolCallMessage struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// LoopConfig controls the agent loop's behavior.
type LoopConfig struct {
	MaxTurns           int
	TurnTimeout        time.Duration
	PermissionMode     string // "standard" or "auto"
	MaxContextMessages int
	DataDirs           []string // paths that trigger user permission for read tool
}

// Loop runs a single agent with tool execution and review pipeline.
type Loop struct {
	agent       *Agent
	registry    *tools.Registry
	reviewModel *ReviewModel
	summarizer  *SessionSummarizer
	credits     *subscription.CreditService
	plan        *subscription.Plan
	config      LoopConfig
	billingMode string
	messages    []Message
	turnCount   int
	totalCost   float64
	userID      string
	convID      string
	userRequest string // original user message, used in review context

	// Per-turn cached session summary for the review model, so multiple tool
	// calls in one turn share one summary call.
	cachedSummary  string
	summaryForTurn int

	events   chan Event
	stopCh   chan struct{}
	stopOnce sync.Once

	consumerReady chan struct{}
	readyOnce     sync.Once

	pendingPerm   map[string]chan bool
	pendingPermMu sync.Mutex
}

// NewLoop creates a new agent loop.
func NewLoop(agent *Agent, registry *tools.Registry, reviewModel *ReviewModel, credits *subscription.CreditService, plan *subscription.Plan, config LoopConfig, billingMode, userID, convID string) *Loop {
	if config.MaxTurns <= 0 {
		config.MaxTurns = 10
	}
	if config.MaxContextMessages <= 0 {
		config.MaxContextMessages = 80
	}
	return &Loop{
		agent:         agent,
		registry:      registry,
		reviewModel:   reviewModel,
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

// SetSessionSummarizer attaches an optional session-summary model. When set,
// the review model receives an LLM-generated summary of the session instead of
// a raw truncated transcript, so it can judge tool calls with real context.
// Unset (the default), the loop falls back to the transcript summary.
func (l *Loop) SetSessionSummarizer(s *SessionSummarizer) {
	l.summarizer = s
}

// Events returns the event stream channel.
func (l *Loop) Events() <-chan Event {
	return l.events
}

// MarkConsumerReady signals that the SSE consumer is connected.
func (l *Loop) MarkConsumerReady() {
	l.readyOnce.Do(func() {
		close(l.consumerReady)
	})
}

// LoadHistory loads previous messages into the loop.
func (l *Loop) LoadHistory(msgs []Message) {
	l.messages = append(l.messages[:0], msgs...)
}

// Stop terminates the loop.
func (l *Loop) Stop() {
	l.stopOnce.Do(func() {
		close(l.stopCh)
	})
}

// HandlePermissionResponse delivers the user's permission decision.
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

// Run executes the agent loop for a single user message.
func (l *Loop) Run(ctx context.Context, userMessage string) {
	defer close(l.events)

	l.userRequest = userMessage

	slog.Debug("agent loop starting", "conv_id", l.convID)

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

		l.emit(Event{Type: EventAgentThinking, Data: AgentThinkingData{
			Model:       l.agent.Model,
			AvatarShape: l.agent.AvatarShape,
			AvatarColor: l.agent.AvatarColor,
		}})

		// Build context for this turn.
		msgs := l.buildMessages()

		callCtx, cancel := context.WithTimeout(ctx, l.config.TurnTimeout)
		resp, usage, err := l.agent.Call(callCtx, msgs, l.registry.ToolDefinitions())
		cancel()

		if err != nil {
			l.emit(Event{Type: EventError, Data: ErrorData{Message: err.Error()}})
			l.emitDone("error")
			return
		}

		// Track usage.
		if usage != nil {
			l.totalCost += usage.CostUSD
			_ = l.deductCredits(ctx, l.agent.Model, usage)
			l.emitUsageUpdate(usage)
		}

		// Emit any text the agent produced.
		if resp.Content != "" {
			l.emit(Event{Type: EventAgentMessage, Data: AgentMessageData{Content: resp.Content}})
		}

		// Process tool calls through the review pipeline.
		if len(resp.ToolCalls) > 0 {
			finished := l.processToolCalls(ctx, resp)
			if finished {
				return
			}
			continue
		}

		// No tool calls and has content → final response.
		if resp.Content != "" {
			l.emitAgentResponse(resp.Content)
			l.emitDone("complete")
			return
		}

		// No tools and no content — agent had nothing to say.
		// Add a nudge to keep it going.
		l.messages = append(l.messages, Message{
			Role:    RoleSystem,
			Content: "You produced no output. If you need more information, use the available tools. If you have an answer, respond in plain language.",
		})
	}

	// Max turns reached.
	msg := "I've reached the limit of what I can check automatically. You may want to try a more specific question, or check your apps directly."
	if l.emitAgentResponse(msg) {
		// response emitted
	}
	l.emitDone("max_turns")
}

// processToolCalls handles the tool execution pipeline for one agent turn.
// Returns true if the loop should stop (error or final response emitted).
func (l *Loop) processToolCalls(ctx context.Context, resp *AgentResponse) bool {
	// Record the assistant message in history.
	var tcs []ToolCallMessage
	for _, tc := range resp.ToolCalls {
		tcs = append(tcs, ToolCallMessage{
			ID:        tc.ID,
			Name:      tc.Name,
			Arguments: tc.Arguments,
		})
	}
	l.messages = append(l.messages, Message{
		Role:      RoleAssistant,
		Content:   resp.Content,
		ToolCalls: tcs,
	})

	// Process each tool call.
	allDenied := true
	for _, tc := range resp.ToolCalls {
		select {
		case <-l.stopCh:
			l.emitDone("user_stopped")
			return true
		case <-ctx.Done():
			l.emitDone("context_cancelled")
			return true
		default:
		}

		tool, ok := l.registry.Get(tc.Name)
		if !ok {
			l.messages = append(l.messages, Message{
				Role:       RoleTool,
				ToolCallID: tc.ID,
				Content:    fmt.Sprintf("unknown tool: %s", tc.Name),
			})
			l.emit(Event{Type: EventToolResult, Data: ToolResultData{
				ID: tc.ID, Content: fmt.Sprintf("unknown tool: %s", tc.Name), IsError: true,
			}})
			continue
		}

		l.emit(Event{Type: EventToolCall, Data: ToolCallData{
			ID: tc.ID, Name: tc.Name, Arguments: tc.Arguments,
		}})

		executed, denied := l.executeWithReview(ctx, tool, tc)
		if denied {
			continue
		}
		if executed {
			allDenied = false
		}
	}

	// If all tool calls were denied, tell the agent and keep going.
	if allDenied && len(resp.ToolCalls) > 0 {
		l.messages = append(l.messages, Message{
			Role:    RoleSystem,
			Content: "All of your tool calls were denied for safety reasons. Please try a different approach or explain to the user what you need.",
		})
	}

	return false
}

// recordToolDenial appends a tool result that explains why a call was blocked
// and emits the matching tool_result event. Every denial path uses this so the
// agent always learns why its tool call did not run (and the tool-call protocol
// stays balanced: every tool_call receives a tool result, which the provider
// requires for the next turn).
func (l *Loop) recordToolDenial(tc AgentToolCall, content string) {
	l.messages = append(l.messages, Message{
		Role:       RoleTool,
		ToolCallID: tc.ID,
		Content:    content,
	})
	l.emit(Event{Type: EventToolResult, Data: ToolResultData{
		ID: tc.ID, Content: content, IsError: true,
	}})
}

// executeWithReview runs a single tool call through the review/permission pipeline.
// Returns (executed, denied). denied=true means the tool call was blocked by review or user.
func (l *Loop) executeWithReview(ctx context.Context, tool *tools.Tool, tc AgentToolCall) (executed, denied bool) {
	autoMode := l.config.PermissionMode == "auto"

	// 1. AlwaysRequirePermission: skip review, ask user directly. In autonomous
	//    mode there is no user to ask, so these tools cannot run.
	if tool.AlwaysRequirePermission {
		approved := l.requestUserPermission(ctx, tc.ID, tc.Name, tool.Description)
		if !approved {
			l.recordToolDenial(tc, "Permission denied: this action requires user approval, which is not available right now.")
			return false, true
		}
		return l.executeTool(ctx, tc, tool)
	}

	// 2. User-data protection: any path-bearing tool (read/write/edit) touching a
	//    protected data directory always requires explicit user approval. This is
	//    a hard rule — it never goes to the review model and is never auto-allowed
	//    — because user data (app data, backups, databases, personal files) must
	//    always be confirmed. In autonomous mode (no user available) this blocks
	//    the call rather than running it.
	if tool.PathExtractor != nil {
		path := tool.PathExtractor(tc.Arguments)
		if path != "" && l.isDataDir(path) {
			reason := fmt.Sprintf(
				"The agent wants to %s %s, which is in a protected data directory. This may contain private information like passwords, configuration secrets, or your personal files.",
				tc.Name, path,
			)
			approved := l.requestUserPermissionWithReason(ctx, tc.ID, tc.Name, reason)
			if !approved {
				l.recordToolDenial(tc, "Permission denied: accessing a protected data directory requires your approval.")
				return false, true
			}
			return l.executeTool(ctx, tc, tool)
		}
		// Non-data-dir paths fall through: read auto-executes (step 4),
		// write/edit go through the review model (step 3).
	}

	// 3. AlwaysReview or no special flags: pass through review model.
	if tool.AlwaysReview {
		contextSummary := l.reviewContextFor(ctx)
		result, err := l.reviewModel.Review(ctx, l.userRequest, tc.Name, tc.Arguments, contextSummary, autoMode)
		if err != nil {
			// Review model failed — default to "review" (ask user) for safety.
			approved := l.requestUserPermission(ctx, tc.ID, tc.Name, tool.Description)
			if !approved {
				l.recordToolDenial(tc, "Permission denied: the safety review could not be completed, so the action was not run.")
				return false, true
			}
			return l.executeTool(ctx, tc, tool)
		}

		l.emit(Event{Type: EventToolReview, Data: ToolReviewData{
			ToolCallID: tc.ID,
			ToolName:   tc.Name,
			Verdict:    string(result.Verdict),
			Reason:     result.Reason,
		}})

		switch result.Verdict {
		case ReviewDeny:
			l.recordToolDenial(tc, fmt.Sprintf("Blocked by safety review: %s", result.Reason))
			return false, true

		case ReviewReview:
			approved := l.requestUserPermissionWithReason(ctx, tc.ID, tc.Name, result.Reason)
			if !approved {
				l.recordToolDenial(tc, fmt.Sprintf("Permission denied by user. Safety review note: %s", result.Reason))
				return false, true
			}
			return l.executeTool(ctx, tc, tool)

		case ReviewAllow:
			return l.executeTool(ctx, tc, tool)
		}
	}

	// 4. Auto-approve: execute immediately (shouldn't reach here with current tools).
	return l.executeTool(ctx, tc, tool)
}

// executeTool runs the tool and records the result.
func (l *Loop) executeTool(ctx context.Context, tc AgentToolCall, tool *tools.Tool) (executed, denied bool) {
	result, err := tool.Execute(ctx, tc.Arguments)

	isErr := err != nil
	content := result
	if err != nil {
		content = err.Error()
	}

	l.messages = append(l.messages, Message{
		Role:       RoleTool,
		ToolCallID: tc.ID,
		Content:    content,
	})
	l.emit(Event{Type: EventToolResult, Data: ToolResultData{
		ID: tc.ID, Content: content, IsError: isErr,
	}})

	return true, false
}

// requestUserPermission asks the user for permission and waits for a response.
func (l *Loop) requestUserPermission(ctx context.Context, id, toolName, reason string) bool {
	return l.requestUserPermissionWithReason(ctx, id, toolName, reason)
}

// requestUserPermissionWithReason asks for user permission with a specific reason.
// In autonomous mode (auto) there is no human watching to confirm actions, so this
// returns false immediately rather than blocking until timeout — the review
// model is expected to have already decided allow/deny (auto mode removes the
// "review" option), so reaching this path at all means an action could not be
// confirmed and must not run.
func (l *Loop) requestUserPermissionWithReason(ctx context.Context, id, toolName, reason string) bool {
	if l.config.PermissionMode == "auto" {
		return false
	}

	permCh := make(chan bool, 1)
	l.pendingPermMu.Lock()
	l.pendingPerm[id] = permCh
	l.pendingPermMu.Unlock()
	defer func() {
		l.pendingPermMu.Lock()
		delete(l.pendingPerm, id)
		l.pendingPermMu.Unlock()
	}()

	l.emit(Event{Type: EventPermissionRequest, Data: PermissionRequestData{
		ID:       id,
		ToolName: toolName,
		Reason:   reason,
	}})

	select {
	case approved := <-permCh:
		return approved
	case <-l.stopCh:
		return false
	case <-ctx.Done():
		return false
	case <-time.After(l.config.TurnTimeout):
		return false
	}
}

// buildMessages prepares the message list for the agent call, applying context limits.
func (l *Loop) buildMessages() []Message {
	if l.config.MaxContextMessages > 0 && len(l.messages) > l.config.MaxContextMessages {
		// Summarize old messages to stay within context window.
		summarized, err := l.summarizeOldMessages(context.Background(), l.messages)
		if err == nil && len(summarized) > 0 {
			return summarized
		}
	}
	msgs := make([]Message, len(l.messages))
	copy(msgs, l.messages)
	return msgs
}

// reviewContextFor returns the session context to hand the review model for
// the current turn. When a session summarizer is configured it uses an
// LLM-generated summary (computed once per turn and cached so multiple tool
// calls in a turn share one summary call); otherwise it falls back to a
// truncated transcript. A failed summary call also falls back to the transcript
// rather than blocking the review.
func (l *Loop) reviewContextFor(ctx context.Context) string {
	if l.summarizer != nil && l.summarizer.Available() && l.summaryForTurn != l.turnCount {
		summary, err := l.summarizer.Summarize(ctx, l.messages)
		// Mark the turn as attempted either way so we don't retry on every tool
		// call in the same turn if the model is failing.
		l.summaryForTurn = l.turnCount
		if err == nil && strings.TrimSpace(summary) != "" {
			l.cachedSummary = summary
		}
	}
	if l.cachedSummary != "" && l.summaryForTurn == l.turnCount {
		return l.cachedSummary
	}
	return l.buildContextSummary()
}

// buildContextSummary creates a brief summary of the conversation for the review model.
func (l *Loop) buildContextSummary() string {
	const maxEntries = 10
	start := len(l.messages) - maxEntries
	if start < 0 {
		start = 0
	}

	var parts []string
	for _, m := range l.messages[start:] {
		switch m.Role {
		case RoleUser:
			parts = append(parts, fmt.Sprintf("User: %s", truncate(m.Content, 300)))
		case RoleAssistant:
			if m.Content != "" {
				parts = append(parts, fmt.Sprintf("Agent: %s", truncate(m.Content, 300)))
			}
			for _, tc := range m.ToolCalls {
				parts = append(parts, fmt.Sprintf("Agent called tool: %s", tc.Name))
			}
		case RoleTool:
			parts = append(parts, fmt.Sprintf("Tool result (%s): %s", m.ToolCallID, truncate(m.Content, 200)))
		}
	}

	if len(parts) == 0 {
		return "No prior conversation."
	}
	return strings.Join(parts, "\n")
}

// isDataDir checks if a path falls within any configured data directory.
func (l *Loop) isDataDir(path string) bool {
	for _, dd := range l.config.DataDirs {
		dd = strings.TrimRight(dd, "/")
		if strings.HasPrefix(path, dd+"/") || path == dd {
			return true
		}
	}
	return false
}

// summarizeOldMessages compresses old messages when the context window is exceeded.
func (l *Loop) summarizeOldMessages(ctx context.Context, msgs []Message) ([]Message, error) {
	if l.agent.provider == nil {
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
				oldParts = append(oldParts, fmt.Sprintf("Agent: %s", m.Content))
			}
			for _, tc := range m.ToolCalls {
				oldParts = append(oldParts, fmt.Sprintf("Agent called %s", tc.Name))
			}
		case RoleTool:
			oldParts = append(oldParts, fmt.Sprintf("Tool result: %s", truncate(m.Content, 200)))
		}
	}

	summarizePrompt := fmt.Sprintf(
		"Summarize the following conversation history concisely. Preserve key facts, decisions, and any unresolved issues.\n\n%s",
		strings.Join(oldParts, "\n"),
	)

	sumMsgs := []Message{
		{Role: RoleSystem, Content: "You are a conversation summarizer. Produce a brief, factual summary preserving all key information."},
		{Role: RoleUser, Content: summarizePrompt},
	}

	resp, summaryUsage, err := l.agent.provider.Chat(ctx, l.agent.Model, sumMsgs, nil)
	if err != nil {
		return msgs, err
	}

	if summaryUsage != nil {
		l.totalCost += summaryUsage.CostUSD
		_ = l.deductCredits(ctx, l.agent.Model, summaryUsage)
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

// --- Credit / Usage ---

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

// --- Event Helpers ---

func (l *Loop) emit(e Event) {
	select {
	case l.events <- e:
	case <-l.stopCh:
		return
	case <-time.After(10 * time.Second):
		slog.Error("agent loop: event channel full, dropping event", "type", e.Type)
	}
}

func (l *Loop) emitAgentResponse(content string) bool {
	select {
	case l.events <- Event{Type: EventAgentResponse, Data: AgentResponseData{Content: content}}:
		return true
	case <-l.stopCh:
		return false
	case <-time.After(10 * time.Second):
		slog.Error("agent loop: event channel full, dropping agent_response")
		return false
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

func (l *Loop) emitUsageUpdate(usage *UsageInfo) {
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

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
