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
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/subscription"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

type AgentChatHandler struct {
	db                *database.DB
	dockerClient      *docker.Client
	backupService     *storage.BackupService
	authService       *auth.Service
	conversationStore *conversation.Store
	toolCallStore     *conversation.ToolCallStore
	creditService     *subscription.CreditService
	checker           *subscription.Checker
	modelRegistry     *agent.ModelRegistry

	activeLoops map[string]*agentLoopEntry
	mu          sync.Mutex
}

type agentLoopEntry struct {
	loop      *agent.Loop
	cancel    context.CancelFunc
	proposals map[string]*agent.ProposalData
	mu        sync.Mutex
}

func NewAgentChatHandler(db *database.DB, dockerClient *docker.Client, backupService *storage.BackupService, authService *auth.Service) *AgentChatHandler {
	h := &AgentChatHandler{
		db:            db,
		dockerClient:  dockerClient,
		backupService: backupService,
		authService:   authService,
		activeLoops:   make(map[string]*agentLoopEntry),
	}
	if db != nil {
		h.conversationStore = conversation.NewStore(db)
		h.toolCallStore = conversation.NewToolCallStore(db)
		h.creditService = subscription.NewCreditService(db)
		h.checker = subscription.NewChecker(db)
	}
	provider := agent.NewProviderFromConfig()
	if provider != nil {
		h.modelRegistry = agent.NewModelRegistry(provider)
	}
	return h
}

func (h *AgentChatHandler) ModelRegistry() *agent.ModelRegistry {
	return h.modelRegistry
}

func (h *AgentChatHandler) ListConversations(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	limit := 20
	offset := 0
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := fmt.Sscanf(l, "%d", &limit); err != nil || v != 1 {
			limit = 20
		}
	}
	if o := r.URL.Query().Get("offset"); o != "" {
		if v, err := fmt.Sscanf(o, "%d", &offset); err != nil || v != 1 {
			offset = 0
		}
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

func (h *AgentChatHandler) GetConversation(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Conversation ID is required.")
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
	TriggerType    string   `json:"trigger_type"`
	TriggerAppID   string   `json:"trigger_app_id,omitempty"`
	PermissionMode string   `json:"permission_mode,omitempty"`
	Models         []string `json:"models,omitempty"`
}

func (h *AgentChatHandler) CreateConversation(w http.ResponseWriter, r *http.Request) {
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	cfg := config.Get()
	if cfg == nil || (!hasInferenceKey(cfg)) {
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
	models := req.Models
	if len(models) == 0 {
		chatAgents := config.AgentsByTrigger("chat")
		for _, a := range chatAgents {
			if a.Model != "" {
				models = append(models, a.Model)
			}
		}
	}
	if len(models) == 0 && cfg.Support.DefaultModel != "" {
		models = []string{cfg.Support.DefaultModel}
	}
	if len(models) == 0 {
		response.JSONError(w, http.StatusServiceUnavailable, "No AI model is configured. Please go to Settings → AI Support and select a default model.")
		return
	}
	primaryModel := models[0]
	if primaryModel == "" {
		response.JSONError(w, http.StatusServiceUnavailable, "No AI model is configured. Please go to Settings → AI Support and select a default model.")
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
		Model:          strings.Join(models, ","),
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

func (h *AgentChatHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Conversation ID is required.")
		return
	}
	userID, ok := getUserID(r)
	if !ok {
		response.Unauthorized(w, "not authenticated")
		return
	}
	cfg := config.Get()
	if cfg == nil || (!hasInferenceKey(cfg)) {
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

	h.mu.Lock()
	if _, exists := h.activeLoops[convID]; exists {
		h.mu.Unlock()
		response.JSONError(w, http.StatusConflict, "The agent is already working on this conversation. Please wait for it to finish before sending another message.")
		return
	}
	h.mu.Unlock()

	var req sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSONError(w, http.StatusBadRequest, "Could not understand your message. Please try again.")
		return
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		response.JSONError(w, http.StatusBadRequest, "Please type a message before sending.")
		return
	}

	provider := agent.NewProviderFromConfig()
	if provider == nil {
		response.JSONError(w, http.StatusServiceUnavailable, "AI support is not available right now.")
		return
	}

	chatAgentDefs := config.AgentsByTrigger("chat")
	var agentModels []struct {
		ID          string
		Model       string
		AvatarShape string
		AvatarColor string
	}

	conversationModels := strings.Split(conv.Model, ",")
	if len(conversationModels) > 0 && conversationModels[0] != "" {
		for i, m := range conversationModels {
			m = strings.TrimSpace(m)
			if m == "" {
				continue
			}
			aID := fmt.Sprintf("agent-%d", i+1)
			avatarShape := "circle"
			avatarColor := "#4ECDC4"
			for _, def := range chatAgentDefs {
				if def.Model == m {
					aID = def.ID
					avatarShape = def.AvatarShape
					avatarColor = def.AvatarColor
					break
				}
			}
			if avatarShape == "" {
				shapes := []string{"diamond", "circle", "triangle", "hexagon", "square"}
				colors := []string{"#FF6B35", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7"}
				avatarShape = shapes[i%len(shapes)]
				avatarColor = colors[i%len(colors)]
			}
			agentModels = append(agentModels, struct {
				ID          string
				Model       string
				AvatarShape string
				AvatarColor string
			}{ID: aID, Model: m, AvatarShape: avatarShape, AvatarColor: avatarColor})
		}
	}
	if len(agentModels) == 0 {
		for i, def := range chatAgentDefs {
			agentModels = append(agentModels, struct {
				ID          string
				Model       string
				AvatarShape string
				AvatarColor string
			}{ID: def.ID, Model: def.Model, AvatarShape: def.AvatarShape, AvatarColor: def.AvatarColor})
			if i >= 1 {
				break
			}
		}
	}
	if len(agentModels) == 0 {
		agentModels = append(agentModels, struct {
			ID          string
			Model       string
			AvatarShape string
			AvatarColor string
		}{ID: "agent-1", Model: cfg.Support.DefaultModel, AvatarShape: "diamond", AvatarColor: "#FF6B35"})
	}

	toolNames := []string{"docker", "files", "diagnostics", "snapshots"}
	if len(chatAgentDefs) > 0 {
		toolNames = chatAgentDefs[0].ToolNames
	}
	agentDefForTools := config.AgentDefinition{ToolNames: toolNames}
	registry := tools.RegistryFromAgentDef(agentDefForTools, tools.ToolDeps{
		DockerClient:  h.dockerClient,
		PathPolicy:    support.NewDefaultPolicy(nil),
		BackupService: h.backupService,
	})

	plan := h.checker.PlanForUser(r.Context(), userID)

	loopConfig := agent.LoopConfig{
		MaxTurns:             cfg.Support.Agent.MaxTurns,
		TurnTimeout:          cfg.Support.Agent.TurnTimeout,
		PermissionMode:       conv.PermissionMode,
		SnapshotBeforeWrites: cfg.Support.Agent.SnapshotBeforeWrites,
		MaxContextMessages:   80,
	}
	if loopConfig.MaxTurns == 0 {
		loopConfig.MaxTurns = 10
	}
	if loopConfig.MaxTurns > 15 {
		loopConfig.MaxTurns = 15
	}
	if loopConfig.TurnTimeout == 0 {
		loopConfig.TurnTimeout = 5 * time.Minute
	}

	systemPrompt := ""
	if len(chatAgentDefs) > 0 && chatAgentDefs[0].SystemPrompt != "" {
		systemPrompt = chatAgentDefs[0].SystemPrompt
	}
	if systemPrompt == "" {
		systemPrompt = buildSystemPrompt(loopConfig.MaxTurns)
	}

	var agents []*agent.Agent
	for _, am := range agentModels {
		// Each agent should use its own system prompt from its definition.
		// This ensures agents have distinct roles rather than being an echo chamber.
		agentPrompt := systemPrompt // fallback to shared prompt
		for _, def := range chatAgentDefs {
			if def.ID == am.ID && def.SystemPrompt != "" {
				agentPrompt = def.SystemPrompt
				break
			}
		}
		agents = append(agents, agent.NewAgent(am.ID, am.Model, am.AvatarShape, am.AvatarColor, agentPrompt, provider))
	}

	loop := agent.NewLoop(agents, registry, h.creditService, plan, loopConfig, cfg.Support.BillingMode, userID, convID)

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

func (h *AgentChatHandler) StreamConversation(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Conversation ID is required.")
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
	if cfg == nil || (!hasInferenceKey(cfg)) {
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

	// Use a background context with timeout for database operations within the
	// SSE stream. The request context (r.Context()) can be cancelled when the
	// HTTP connection drops, but we still need to persist events that were
	// already generated by the agent loop.
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
		if evt.Type == agent.EventAgentResponse {
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
				if err := h.conversationStore.AddMessage(dbCtx, msg); err != nil {
					slog.Error("failed to save agent response", "conversation_id", convID, "error", err)
				}
			}
		}
		if evt.Type == agent.EventToolCall {
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
					Metadata:       json.RawMessage(fmt.Sprintf(`{"agent_id":"%s"}`, tc.AgentID)),
					CreatedAt:      time.Now(),
				}
				if err := h.conversationStore.AddMessage(dbCtx, assistantMsg); err != nil {
					slog.Error("failed to save tool call", "conversation_id", convID, "error", err)
				}
				if h.toolCallStore != nil {
					if err := h.toolCallStore.Insert(dbCtx, &conversation.ToolCallRecord{
						ID:             tc.ID,
						ConversationID: convID,
						MessageID:      assistantMsg.ID,
						ToolName:       tc.Name,
						ToolArgs:       tc.Arguments,
						Status:         "pending",
						CreatedAt:      time.Now(),
					}); err != nil {
						slog.Error("failed to audit tool call", "tool_call_id", tc.ID, "error", err)
					}
				}
			}
		}
		if evt.Type == agent.EventToolResult {
			data, _ := json.Marshal(evt.Data)
			var tr agent.ToolResultData
			if err := json.Unmarshal(data, &tr); err == nil {
				metaJSON, _ := json.Marshal(map[string]string{"tool_call_id": tr.ID, "agent_id": tr.AgentID})
				toolMsg := &conversation.Message{
					ID:             conversation.GenerateID(),
					ConversationID: convID,
					Role:           "tool",
					Content:        tr.Content,
					ContentType:    "tool_result",
					Visibility:     "internal",
					Metadata:       metaJSON,
					CreatedAt:      time.Now(),
				}
				if err := h.conversationStore.AddMessage(dbCtx, toolMsg); err != nil {
					slog.Error("failed to save tool result", "conversation_id", convID, "error", err)
				}
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
					if err := h.toolCallStore.UpdateResult(dbCtx, tr.ID, status, resultContent, errStr); err != nil {
						slog.Error("failed to audit tool result", "tool_call_id", tr.ID, "error", err)
					}
				}
			}
		}
		if evt.Type == agent.EventProposal {
			data, _ := json.Marshal(evt.Data)
			var pd agent.ProposalData
			if err := json.Unmarshal(data, &pd); err == nil {
				h.mu.Lock()
				entry, ok := h.activeLoops[convID]
				h.mu.Unlock()
				if ok {
					entry.mu.Lock()
					if entry.proposals == nil {
						entry.proposals = make(map[string]*agent.ProposalData)
					}
					entry.proposals[pd.ID] = &pd
					entry.mu.Unlock()
				}
			}
		}
		if evt.Type == agent.EventProposal || evt.Type == agent.EventVote || evt.Type == agent.EventConsensus {
			reviewJSON, _ := json.Marshal(evt.Data)
			reviewMsg := &conversation.Message{
				ID:             conversation.GenerateID(),
				ConversationID: convID,
				Role:           "system",
				Content:        string(reviewJSON),
				ContentType:    "deliberation",
				Visibility:     "internal",
				CreatedAt:      time.Now(),
			}
			if err := h.conversationStore.AddMessage(dbCtx, reviewMsg); err != nil {
				slog.Error("failed to save deliberation event", "conversation_id", convID, "error", err)
			}
			if evt.Type == agent.EventConsensus && h.toolCallStore != nil {
				data, _ := json.Marshal(evt.Data)
				var cd agent.ConsensusData
				if err := json.Unmarshal(data, &cd); err == nil && cd.Result == "approved" {
					pd := h.findPendingProposal(convID, cd.ProposalID)
					if pd != nil {
						for _, tc := range pd.ToolCalls {
							approvedBy := "consensus"
							_ = h.toolCallStore.UpdateApprovedBy(dbCtx, tc.ID, approvedBy)
						}
					}
				}
			}
		}
		if evt.Type == agent.EventSnapshotCreated && h.toolCallStore != nil {
			data, _ := json.Marshal(evt.Data)
			var sc agent.SnapshotCreatedData
			if err := json.Unmarshal(data, &sc); err == nil && sc.ToolCallID != "" && sc.SnapshotID != "" {
				_ = h.toolCallStore.UpdateSnapshotID(dbCtx, sc.ToolCallID, sc.SnapshotID)
			}
		}
		if evt.Type == agent.EventDone {
			data, _ := json.Marshal(evt.Data)
			var done agent.DoneData
			if err := json.Unmarshal(data, &done); err == nil {
				newStatus := "resolved"
				if done.Reason == "user_stopped" {
					newStatus = "cancelled"
				}
				if err := h.conversationStore.UpdateStatus(dbCtx, convID, newStatus); err != nil {
					slog.Error("failed to update conversation status", "conversation_id", convID, "error", err)
				}
			}
		}

		encoded, err := json.Marshal(evt)
		if err != nil {
			continue
		}

		// Detect SSE client disconnect: if the write or flush fails,
		// the client has gone away. Stop the loop to prevent credit waste.
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

func (h *AgentChatHandler) ListToolCalls(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Conversation ID is required.")
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

func (h *AgentChatHandler) RespondPermission(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Conversation ID is required.")
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
		response.JSONError(w, http.StatusBadRequest, "Could not understand the request.")
		return
	}
	if req.ToolCallID == "" {
		response.JSONError(w, http.StatusBadRequest, "Tool call ID is required.")
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

func (h *AgentChatHandler) StopConversation(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationID")
	if convID == "" {
		response.JSONError(w, http.StatusBadRequest, "Conversation ID is required.")
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
	if err := h.conversationStore.UpdateStatus(r.Context(), convID, "cancelled"); err != nil {
		slog.Error("failed to cancel conversation", "conversation_id", convID, "error", err)
	}

	response.JSON(w, http.StatusOK, map[string]string{"status": "stopped"})
}

func (h *AgentChatHandler) GetModels(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	if cfg == nil || (!hasInferenceKey(cfg)) {
		response.JSONError(w, http.StatusServiceUnavailable, "AI support is not configured. Please go to Settings → AI Support to set up your AI provider.")
		return
	}
	if h.modelRegistry == nil {
		response.JSONError(w, http.StatusInternalServerError, "Model registry not available.")
		return
	}
	models, err := h.modelRegistry.List(r.Context())
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
		response.JSONError(w, http.StatusBadRequest, "Could not understand the request.")
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

func getUserID(r *http.Request) (string, bool) {
	id, ok := middleware.GetUserID(r.Context())
	return id, ok
}

func hasInferenceKey(cfg *config.Config) bool {
	if cfg.Support.DeviceToken != "" && cfg.Support.ServerURL != "" {
		return true
	}
	return cfg.Support.BYOKEnabled && cfg.Support.UserAPIKey != ""
}

func (h *AgentChatHandler) validateSSEToken(token string) (*auth.Claims, error) {
	if h.authService == nil {
		return nil, fmt.Errorf("auth service not available")
	}
	return h.authService.ValidateAccessToken(token)
}

// extractSSEAuth extracts user identity for SSE connections.
// EventSource cannot send custom headers, so we accept auth via:
//  1. HttpOnly cookie (preferred — not exposed to JS or logs)
func (h *AgentChatHandler) extractSSEAuth(r *http.Request) string {
	if cookie, err := r.Cookie("libreserv_access"); err == nil && cookie.Value != "" {
		claims, err := h.validateSSEToken(cookie.Value)
		if err == nil && claims != nil {
			return claims.UserID
		}
	}
	return ""
}

func buildSystemPrompt(maxTurns int) string {
	if maxTurns <= 0 {
		maxTurns = 10
	}
	return fmt.Sprintf(`You are the LibreServ Support Agent, an AI assistant that helps users manage their self-hosted server. You work alongside other agents as a team — together you research problems, propose solutions, and must reach unanimous agreement before making changes or responding to the user.

Key principles:
- Research freely: check containers, read logs, inspect health — no approval needed for read-only actions.
- Propose writes carefully: any changes (restarting containers, editing files, modifying config) require all agents to agree before execution.
- Respond in plain language: the user is not technical. Never expose model names, tool names, error codes, or internal reasoning.
- Explain what you are doing: before making changes, explain what you are about to do and why.
- If something goes wrong, suggest clear next steps the user can follow.
- You can see what other agents have discovered. Build on their findings rather than repeating the same checks.

CRITICAL WORKFLOW RULES:
- After you call a tool, its result is provided in the next turn. WAIT for those results rather than calling the same tool again.
- DO NOT repeat a tool call with the same arguments. The result is already cached and available to all agents.
- When you have enough information to answer the user's question, STOP calling tools and produce a final response directly in plain language.
- If the user's question is simple (e.g., "check health", "list apps"), 1-3 tool calls are usually enough. More than 5 tool calls for a single question wastes turns and costs money.
- The system enforces a maximum of %d turns. You MUST reach a conclusion before then.`, maxTurns)
}

func (h *AgentChatHandler) findPendingProposal(convID, proposalID string) *agent.ProposalData {
	h.mu.Lock()
	entry, ok := h.activeLoops[convID]
	h.mu.Unlock()
	if !ok {
		return nil
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.proposals == nil {
		return nil
	}
	return entry.proposals[proposalID]
}
