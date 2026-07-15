package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/conversation"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/tools"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/subscription"
)

// AgentChatHandler handles all agent conversation API endpoints.
type AgentChatHandler struct {
	db                *database.DB
	authService       *auth.Service
	creditService     *subscription.CreditService
	checker           *subscription.Checker
	conversationStore *conversation.Store
	toolCallStore     *conversation.ToolCallStore
	connectClient     connect.Client
	connectChecker    *connect.EntitlementChecker

	activeLoops map[string]*agentLoopEntry
	mu          sync.Mutex
}

type agentLoopEntry struct {
	loop   *agent.Loop
	cancel context.CancelFunc
}

// NewAgentChatHandler creates a new handler with all required dependencies.
func NewAgentChatHandler(db *database.DB, authService *auth.Service, connectClient connect.Client, connectChecker *connect.EntitlementChecker) *AgentChatHandler {
	h := &AgentChatHandler{
		db:             db,
		authService:    authService,
		connectClient:  connectClient,
		connectChecker: connectChecker,
		activeLoops:    make(map[string]*agentLoopEntry),
	}
	if db != nil {
		h.conversationStore = conversation.NewStore(db)
		h.toolCallStore = conversation.NewToolCallStore(db)
		h.creditService = subscription.NewCreditService(db)
		h.checker = subscription.NewChecker(db)
	}
	return h
}

// ModelsSource returns a function that can list available AI models from the
// currently configured source. It is wired into the settings handler so the
// AI support UI can refresh the dropdown without starting a conversation.
func (h *AgentChatHandler) ModelsSource() func(ctx context.Context) ([]agent.ModelInfo, error) {
	return func(ctx context.Context) ([]agent.ModelInfo, error) {
		return agent.ListAIModels(ctx, h.connectClient, h.connectChecker)
	}
}

// ListConversations returns the user's recent conversations.
func (h *AgentChatHandler) ListConversations(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	limit := 20
	offset := 0
	if l := r.URL.Query().Get("limit"); l != "" {
		fmt.Sscanf(l, "%d", &limit)
	}
	if o := r.URL.Query().Get("offset"); o != "" {
		fmt.Sscanf(o, "%d", &offset)
	}
	convs, err := h.conversationStore.ListByUser(r.Context(), userID, limit, offset)
	if err != nil {
		slog.Error("failed to list conversations", "user_id", userID, "error", err)
		response.JSONError(w, http.StatusInternalServerError, "Could not load your conversation history. Please try again later.")
		return
	}
	if convs == nil {
		convs = []*conversation.Conversation{}
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"conversations": convs,
		"count":         len(convs),
	})
}

// GetConversation returns a single conversation with its messages.
func (h *AgentChatHandler) GetConversation(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Please specify which conversation to use.")
		return
	}
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	conv, err := h.conversationStore.Get(r.Context(), convID)
	if err != nil {
		response.JSONError(w, http.StatusNotFound, "That conversation could not be found. It may have been deleted.")
		return
	}
	if conv.UserID != userID {
		response.Forbidden(w, "You can only view your own conversations.")
		return
	}
	messages, err := h.conversationStore.Messages(r.Context(), convID, 100, 0)
	if err != nil {
		slog.Error("failed to load messages", "conversation_id", convID, "error", err)
		response.JSONError(w, http.StatusInternalServerError, "Could not load messages for this conversation. Please try again later.")
		return
	}
	if messages == nil {
		messages = []*conversation.Message{}
	}
	events, _ := h.conversationStore.Events(r.Context(), convID, 1000, 0)
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"conversation": conv,
		"messages":     messages,
		"events":       events,
	})
}

type createConversationRequest struct {
	TriggerType    string `json:"trigger_type"`
	TriggerAppID   string `json:"trigger_app_id,omitempty"`
	PermissionMode string `json:"permission_mode,omitempty"`
	Model          string `json:"model,omitempty"`
}

// CreateConversation starts a new agent conversation.
func (h *AgentChatHandler) CreateConversation(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	cfg := config.Get()
	if cfg == nil || !agent.AIConfigured(h.connectClient, h.connectChecker) {
		response.JSONError(w, http.StatusServiceUnavailable, "AI support is not configured. Please go to Settings → AI Support to set up your AI provider.")
		return
	}

	var req createConversationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSONError(w, http.StatusBadRequest, "Could not understand the request. Please try again.")
		return
	}
	if req.TriggerType == "" {
		req.TriggerType = "manual"
	}
	if req.PermissionMode == "" {
		req.PermissionMode = "standard"
	}
	// Validate permission mode — only known modes may drive the agent loop's
	// auto-approval behavior. An arbitrary value would silently fall back to
	// the standard path, but rejecting it keeps the contract explicit.
	switch req.PermissionMode {
	case "standard", "auto":
	default:
		response.JSONError(w, http.StatusBadRequest, "That permission mode isn't available. Please choose a supported option.")
		return
	}
	model := req.Model
	if model == "" {
		model = cfg.Support.Agent.MainModel
	}
	if model == "" {
		response.JSONError(w, http.StatusServiceUnavailable, "No AI model is configured. Please go to Settings → AI Support and select an agent model.")
		return
	}

	plan := h.checker.PlanForUser(r.Context(), userID)

	convID := conversation.GenerateID()
	now := time.Now()
	conv := &conversation.Conversation{
		ID:             convID,
		UserID:         userID,
		Status:         "active",
		TriggerType:    req.TriggerType,
		TriggerAppID:   req.TriggerAppID,
		PlanID:         plan.ID,
		PermissionMode: req.PermissionMode,
		Model:          model,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := h.conversationStore.Create(r.Context(), conv); err != nil {
		slog.Error("failed to create conversation", "user_id", userID, "error", err)
		response.JSONError(w, http.StatusInternalServerError, "Could not start a new conversation. Please try again later.")
		return
	}
	response.JSONCreated(w, conv)
}

type sendMessageRequest struct {
	Content string `json:"content"`
}

// SendMessage sends a message to the agent and starts the loop.
func (h *AgentChatHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Please specify which conversation to use.")
		return
	}
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	cfg := config.Get()
	if cfg == nil || !agent.AIConfigured(h.connectClient, h.connectChecker) {
		response.JSONError(w, http.StatusServiceUnavailable, "AI support is not configured. Please go to Settings → AI Support to set up your AI provider.")
		return
	}

	conv, err := h.conversationStore.Get(r.Context(), convID)
	if err != nil {
		response.JSONError(w, http.StatusNotFound, "That conversation could not be found.")
		return
	}
	if conv.UserID != userID {
		response.Forbidden(w, "You can only send messages to your own conversations.")
		return
	}
	if conv.Status != "active" {
		response.JSONError(w, http.StatusBadRequest, "This conversation has ended. Start a new one to continue getting help.")
		return
	}

	// Atomically check and reserve the active loop slot to prevent race conditions.
	h.mu.Lock()
	if _, exists := h.activeLoops[convID]; exists {
		h.mu.Unlock()
		response.JSONError(w, http.StatusConflict, "The agent is already working on this conversation. Please wait for it to finish before sending another message.")
		return
	}
	// Reserve immediately.
	h.activeLoops[convID] = &agentLoopEntry{}
	h.mu.Unlock()

	var req sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.mu.Lock()
		delete(h.activeLoops, convID)
		h.mu.Unlock()
		response.JSONError(w, http.StatusBadRequest, "Could not understand your message. Please try again.")
		return
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		h.mu.Lock()
		delete(h.activeLoops, convID)
		h.mu.Unlock()
		response.JSONError(w, http.StatusBadRequest, "Please type a message before sending.")
		return
	}

	provider := agent.NewAIProvider(r.Context(), h.connectClient, h.connectChecker)
	if provider == nil {
		h.mu.Lock()
		delete(h.activeLoops, convID)
		h.mu.Unlock()
		response.JSONError(w, http.StatusServiceUnavailable, "AI support is not available right now.")
		return
	}

	// Determine the agent model.
	agentModel := conv.Model
	if agentModel == "" {
		agentModel = cfg.Support.Agent.MainModel
	}

	// Build system prompt.
	systemPrompt := cfg.Support.Agent.SystemPrompt
	if systemPrompt == "" {
		systemPrompt = buildSystemPrompt()
	}

	// Create the agent.
	ag := agent.NewAgent("libreserv-agent", agentModel, "diamond", "#FF6B35", systemPrompt, provider)

	// Create the review model (if enabled).
	var reviewModel *agent.ReviewModel
	if cfg.Support.Agent.ReviewEnabled {
		reviewModelID := cfg.Support.Agent.ReviewModel
		if reviewModelID == "" {
			reviewModelID = agentModel // default to same model
		}
		reviewModel = agent.NewReviewModel(provider, reviewModelID)
	}

	// Build the tool registry. The bash tool runs commands through the
	// configured OS sandbox rather than directly on the host.
	sb := agent.NewSandbox(cfg.Support.Agent.Sandbox)
	registry := tools.StandardRegistry(sb)

	// Get plan and build loop config.
	plan := h.checker.PlanForUser(r.Context(), userID)

	dataDirs := cfg.Support.Agent.DataDirs
	if len(dataDirs) == 0 {
		dataDirs = []string{"/var/lib/libreserv", "/etc/libreserv"}
	}

	loopConfig := agent.LoopConfig{
		MaxTurns:           cfg.Support.Agent.MaxTurns,
		TurnTimeout:        cfg.Support.Agent.TurnTimeout,
		PermissionMode:     conv.PermissionMode,
		MaxContextMessages: 80,
		DataDirs:           dataDirs,
	}
	if loopConfig.MaxTurns <= 0 {
		loopConfig.MaxTurns = 10
	}
	if loopConfig.MaxTurns > 15 {
		loopConfig.MaxTurns = 15
	}
	if loopConfig.TurnTimeout <= 0 {
		loopConfig.TurnTimeout = 5 * time.Minute
	}

	loop := agent.NewLoop(ag, registry, reviewModel, h.creditService, plan, loopConfig, cfg.Support.BillingMode, userID, convID)

	// Optional: a dedicated model that summarizes the session so the review
	// model can judge tool calls with real context. Unset = transcript fallback.
	if summaryModelID := cfg.Support.Agent.SummaryModel; summaryModelID != "" {
		loop.SetSessionSummarizer(agent.NewSessionSummarizer(provider, summaryModelID))
	}

	// Load conversation history.
	history, _ := h.conversationStore.Messages(r.Context(), convID, 100, 0)
	if len(history) > 0 {
		var histMsgs []agent.Message
		for _, m := range history {
			msg := agent.Message{
				Role:    agent.MessageRole(m.Role),
				Content: m.Content,
			}
			if m.ToolCalls != nil {
				var tcs []agent.ToolCallMessage
				if err := json.Unmarshal(m.ToolCalls, &tcs); err == nil {
					msg.ToolCalls = tcs
				}
			}
			// Tool messages carry their tool_call_id in metadata.
			if m.Role == "tool" && m.Metadata != nil {
				var meta struct {
					ToolCallID string `json:"tool_call_id"`
				}
				if err := json.Unmarshal(m.Metadata, &meta); err == nil {
					msg.ToolCallID = meta.ToolCallID
				}
			}
			histMsgs = append(histMsgs, msg)
		}
		loop.LoadHistory(histMsgs)
	}

	// Save the user message.
	userMsg := &conversation.Message{
		ID:             conversation.GenerateID(),
		ConversationID: convID,
		Role:           "user",
		Content:        content,
		ContentType:    "text",
		Visibility:     "visible",
		CreatedAt:      time.Now(),
	}
	if err := h.conversationStore.AddMessage(r.Context(), userMsg); err != nil {
		slog.Error("failed to save user message", "conversation_id", convID, "error", err)
		response.JSONError(w, http.StatusInternalServerError, "Could not save your message. Please try again.")
		return
	}

	ctx, cancel := context.WithCancel(context.Background())

	// Update the reserved slot with the real loop.
	h.mu.Lock()
	h.activeLoops[convID] = &agentLoopEntry{loop: loop, cancel: cancel}
	h.mu.Unlock()

	go func() {
		defer func() {
			h.mu.Lock()
			delete(h.activeLoops, convID)
			h.mu.Unlock()
			cancel()
		}()
		loop.Run(ctx, content)
	}()

	response.JSON(w, http.StatusAccepted, map[string]string{
		"status":          "processing",
		"conversation_id": convID,
	})
}

// StreamConversation streams agent events to the client via SSE.
func (h *AgentChatHandler) StreamConversation(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Please specify which conversation to use.")
		return
	}
	userID, ok := getUserID(r)
	if !ok {
		userID = h.extractSSEAuth(r)
		if userID == "" {
			response.Unauthorized(w, "Authentication required. Please log in and try again.")
			return
		}
	}
	cfg := config.Get()
	if cfg == nil || !agent.AIConfigured(h.connectClient, h.connectChecker) {
		response.JSONError(w, http.StatusServiceUnavailable, "AI support is not configured. Please go to Settings → AI Support to set up your AI provider.")
		return
	}

	conv, err := h.conversationStore.Get(r.Context(), convID)
	if err != nil {
		response.JSONError(w, http.StatusNotFound, "That conversation could not be found.")
		return
	}
	if conv.UserID != userID {
		response.Forbidden(w, "You can only access your own conversations.")
		return
	}

	h.mu.Lock()
	l, exists := h.activeLoops[convID]
	h.mu.Unlock()

	if !exists {
		response.JSONError(w, http.StatusNotFound, "No active agent session for this conversation.")
		return
	}

	dbCtx, dbCancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer dbCancel()

	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	l.loop.MarkConsumerReady()
	events := l.loop.Events()
	for evt := range events {
		// Persist important events.
		switch evt.Type {
		case agent.EventAgentResponse:
			data, _ := json.Marshal(evt.Data)
			var resp agent.AgentResponseData
			if err := json.Unmarshal(data, &resp); err == nil && resp.Content != "" {
				msg := &conversation.Message{
					ID:             conversation.GenerateID(),
					ConversationID: convID,
					Role:           "assistant",
					Content:        resp.Content,
					ContentType:    "text",
					Visibility:     "visible",
					CreatedAt:      time.Now(),
				}
				_ = h.conversationStore.AddMessage(dbCtx, msg)
			}

		case agent.EventToolCall:
			data, _ := json.Marshal(evt.Data)
			var tc agent.ToolCallData
			if err := json.Unmarshal(data, &tc); err == nil {
				tcsJSON, _ := json.Marshal([]agent.ToolCallMessage{{
					ID:        tc.ID,
					Name:      tc.Name,
					Arguments: tc.Arguments,
				}})
				assistantMsg := &conversation.Message{
					ID:             conversation.GenerateID(),
					ConversationID: convID,
					Role:           "assistant",
					Content:        "",
					ContentType:    "tool_call",
					Visibility:     "internal",
					ToolCalls:      tcsJSON,
					CreatedAt:      time.Now(),
				}
				_ = h.conversationStore.AddMessage(dbCtx, assistantMsg)
				if h.toolCallStore != nil {
					_ = h.toolCallStore.Insert(dbCtx, &conversation.ToolCallRecord{
						ID:             tc.ID,
						ConversationID: convID,
						MessageID:      assistantMsg.ID,
						ToolName:       tc.Name,
						ToolArgs:       tc.Arguments,
						Status:         "pending",
						CreatedAt:      time.Now(),
					})
				}
			}

		case agent.EventToolResult:
			data, _ := json.Marshal(evt.Data)
			var tr agent.ToolResultData
			if err := json.Unmarshal(data, &tr); err == nil {
				toolMsg := &conversation.Message{
					ID:             conversation.GenerateID(),
					ConversationID: convID,
					Role:           "tool",
					Content:        tr.Content,
					ContentType:    "tool_result",
					Visibility:     "internal",
					CreatedAt:      time.Now(),
				}
				_ = h.conversationStore.AddMessage(dbCtx, toolMsg)
				if h.toolCallStore != nil {
					status := "completed"
					var errStr string
					var resultContent string
					if tr.IsError {
						status = "failed"
						errStr = tr.Content
					} else {
						resultContent = tr.Content
						if len(resultContent) > 10000 {
							resultContent = resultContent[:10000]
						}
					}
					_ = h.toolCallStore.UpdateResult(dbCtx, tr.ID, status, resultContent, errStr)
				}
			}

		case agent.EventToolReview:
			// Persist review verdicts as internal system messages.
			data, _ := json.Marshal(evt.Data)
			reviewMsg := &conversation.Message{
				ID:             conversation.GenerateID(),
				ConversationID: convID,
				Role:           "system",
				Content:        string(data),
				ContentType:    "tool_review",
				Visibility:     "internal",
				CreatedAt:      time.Now(),
			}
			_ = h.conversationStore.AddMessage(dbCtx, reviewMsg)

		case agent.EventDone:
			data, _ := json.Marshal(evt.Data)
			var done agent.DoneData
			if err := json.Unmarshal(data, &done); err == nil {
				newStatus := "resolved"
				if done.Reason == "user_stopped" {
					newStatus = "cancelled"
				}
				_ = h.conversationStore.UpdateStatus(dbCtx, convID, newStatus)
			}
		}

		// Stream the event to the client.
		encoded, err := json.Marshal(evt)
		if err != nil {
			continue
		}

		if _, writeErr := fmt.Fprintf(w, "data: %s\n\n", encoded); writeErr != nil {
			slog.Info("agent SSE: client disconnected, stopping loop", "conversation_id", convID, "error", writeErr)
			l.loop.Stop()
			break
		}
		if flushErr := rc.Flush(); flushErr != nil {
			slog.Info("agent SSE: flush failed (client gone), stopping loop", "conversation_id", convID, "error", flushErr)
			l.loop.Stop()
			break
		}

		_ = h.conversationStore.SaveEvent(dbCtx, convID, string(evt.Type), encoded)
	}
}

// ListToolCalls returns the audit trail of tool calls for a conversation.
func (h *AgentChatHandler) ListToolCalls(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Please specify which conversation to use.")
		return
	}
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	conv, err := h.conversationStore.Get(r.Context(), convID)
	if err != nil || conv.UserID != userID {
		response.Forbidden(w, "You can only view your own conversation audit logs.")
		return
	}
	if h.toolCallStore == nil {
		response.JSON(w, http.StatusOK, map[string]interface{}{"tool_calls": []*conversation.ToolCallRecord{}})
		return
	}
	records, err := h.toolCallStore.ListByConversation(r.Context(), convID)
	if err != nil {
		slog.Error("failed to list tool calls", "conversation_id", convID, "error", err)
		response.JSONError(w, http.StatusInternalServerError, "Could not load audit log for this conversation.")
		return
	}
	if records == nil {
		records = []*conversation.ToolCallRecord{}
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"tool_calls": records,
		"count":      len(records),
	})
}

// RespondPermission handles the user's response to a permission request.
func (h *AgentChatHandler) RespondPermission(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Please specify which conversation to use.")
		return
	}
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}

	var req struct {
		ToolCallID string `json:"tool_call_id"`
		Approved   bool   `json:"approved"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}
	if req.ToolCallID == "" {
		response.JSONError(w, http.StatusBadRequest, "Please specify which tool call.")
		return
	}

	h.mu.Lock()
	e, exists := h.activeLoops[convID]
	h.mu.Unlock()

	if !exists {
		response.JSONError(w, http.StatusNotFound, "No active agent session for this conversation.")
		return
	}

	conv, err := h.conversationStore.Get(r.Context(), convID)
	if err != nil || conv.UserID != userID {
		response.Forbidden(w, "You can only approve actions for your own conversations.")
		return
	}

	e.loop.HandlePermissionResponse(req.ToolCallID, req.Approved)

	response.JSON(w, http.StatusOK, map[string]string{
		"status":       "acknowledged",
		"tool_call_id": req.ToolCallID,
		"approved":     fmt.Sprintf("%v", req.Approved),
	})
}

// StopConversation stops a running agent loop.
func (h *AgentChatHandler) StopConversation(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Please specify which conversation to use.")
		return
	}
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}

	h.mu.Lock()
	entry, exists := h.activeLoops[convID]
	h.mu.Unlock()

	if !exists {
		response.JSONError(w, http.StatusNotFound, "No active agent session for this conversation.")
		return
	}

	conv, err := h.conversationStore.Get(r.Context(), convID)
	if err != nil || conv.UserID != userID {
		response.Forbidden(w, "You can only stop your own conversations.")
		return
	}

	entry.loop.Stop()
	_ = h.conversationStore.UpdateStatus(r.Context(), convID, "cancelled")

	response.JSON(w, http.StatusOK, map[string]string{"status": "stopped"})
}

// GetModels returns available AI models from the configured provider.
func (h *AgentChatHandler) GetModels(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	if cfg == nil || !agent.AIConfigured(h.connectClient, h.connectChecker) {
		response.JSONError(w, http.StatusServiceUnavailable, "AI support is not configured. Please go to Settings → AI Support to set up your AI provider.")
		return
	}
	models, err := agent.ListAIModels(r.Context(), h.connectClient, h.connectChecker)
	if err != nil {
		slog.Error("failed to list models", "error", err)
		response.JSONError(w, http.StatusInternalServerError, "Could not load available AI models. Please try again later.")
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"models": models,
		"count":  len(models),
	})
}

// GetSubscription returns the user's subscription and usage.
func (h *AgentChatHandler) GetSubscription(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	sub, err := h.checker.Subscription(r.Context(), userID)
	if err != nil {
		slog.Error("failed to get subscription", "user_id", userID, "error", err)
		response.JSONError(w, http.StatusInternalServerError, "Could not load your subscription details.")
		return
	}
	plan := h.checker.PlanForUser(r.Context(), userID)
	usageSummary, _ := h.creditService.Usage(r.Context(), userID, plan)
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"subscription": sub,
		"plan":         plan,
		"usage":        usageSummary,
	})
}

// UpdateSubscription changes the user's plan.
func (h *AgentChatHandler) UpdateSubscription(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	var req struct {
		PlanID string `json:"plan_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}
	if req.PlanID == "" {
		response.JSONError(w, http.StatusBadRequest, "Please select a plan.")
		return
	}
	if subscription.PlanByID(req.PlanID) == nil {
		response.JSONError(w, http.StatusBadRequest, "That plan is not available. Please choose from the options shown.")
		return
	}
	if err := h.checker.SetPlan(r.Context(), userID, req.PlanID, ""); err != nil {
		slog.Error("failed to update subscription", "user_id", userID, "plan_id", req.PlanID, "error", err)
		response.JSONError(w, http.StatusInternalServerError, "Could not update your plan. Please try again later.")
		return
	}
	sub, _ := h.checker.Subscription(r.Context(), userID)
	plan := h.checker.PlanForUser(r.Context(), userID)
	usageSummary, _ := h.creditService.Usage(r.Context(), userID, plan)
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"subscription": sub,
		"plan":         plan,
		"usage":        usageSummary,
	})
}

// --- Helpers ---

func getUserID(r *http.Request) (string, bool) {
	id, ok := middleware.GetUserID(r.Context())
	return id, ok
}

func (h *AgentChatHandler) validateSSEToken(token string) (*auth.Claims, error) {
	if h.authService == nil {
		return nil, fmt.Errorf("auth service not available")
	}
	return h.authService.ValidateAccessToken(token)
}

func (h *AgentChatHandler) extractSSEAuth(r *http.Request) string {
	if cookie, err := r.Cookie("libreserv_access"); err == nil && cookie.Value != "" {
		claims, err := h.validateSSEToken(cookie.Value)
		if err == nil && claims != nil {
			return claims.UserID
		}
	}
	return ""
}

func buildSystemPrompt() string {
	return `You are the LibreServ Support Agent. You help non-technical users manage their self-hosted server running LibreServ (a platform for running apps like Nextcloud, SearXNG, Home Assistant, and others).

Key rules:
- Use plain language. Never mention model names, tool names, error codes, or technical jargon in your responses.
- Before making changes, explain what you are about to do and why in simple terms.
- Research freely: check container status, read logs, inspect files — this doesn't affect anything.
- Modifying things (restarting apps, editing files, changing settings) will be reviewed for safety before happening.
- If you need to do something that could disrupt the user's apps, they will be asked to confirm.
- If something goes wrong, suggest clear next steps the user can follow.
- Keep your responses concise and actionable. Don't explain what you already checked unless the user asks.

You have access to bash (for running commands), read (for viewing files), write (for creating files), and edit (for making targeted changes to files). Use them wisely. Don't repeat tool calls that already produced results.`
}
