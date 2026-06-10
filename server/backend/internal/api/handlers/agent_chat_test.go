package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/conversation"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func setupAgentChatTest(t *testing.T) (*AgentChatHandler, *database.DB, func()) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	cfg := &config.Config{
		Auth: config.AuthConfig{JWTSecret: "test-secret", CSRFSecret: "test-csrf"},
		Support: config.SupportConfig{
			DefaultModel: "test-model",
			BYOKEnabled:  true,
			UserAPIKey:   "test-key",
		},
	}
	config.SetTestConfig(cfg)

	h := NewAgentChatHandler(db, nil, nil, nil)
	cleanup := func() {
		config.SetTestConfig(nil)
		_ = db.Close()
	}
	return h, db, cleanup
}

func seedUser(t *testing.T, db *database.DB, id, username string) {
	t.Helper()
	_, err := db.Exec("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", id, username, "hash")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
}

func seedApp(t *testing.T, db *database.DB, id string) {
	t.Helper()
	_, err := db.Exec("INSERT INTO apps (id, name, type, path) VALUES (?, ?, 'builtin', '/tmp')", id, id)
	if err != nil {
		t.Fatalf("seed app: %v", err)
	}
}

func authCtx(r *http.Request, userID string) *http.Request {
	ctx := context.WithValue(r.Context(), middleware.UserIDContextKey, userID)
	return r.WithContext(ctx)
}

func TestAgentChatHandler_ListConversations(t *testing.T) {
	h, db, cleanup := setupAgentChatTest(t)
	defer cleanup()
	seedUser(t, db, "user-a", "alice")
	seedApp(t, db, "app-1")

	ctx := context.Background()
	if err := h.conversationStore.Create(ctx, &conversation.Conversation{
		ID:           "conv-1",
		UserID:       "user-a",
		Status:       "active",
		Model:        "test",
		TriggerAppID: "app-1",
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/support/agent/conversations", nil)
	req = authCtx(req, "user-a")
	w := httptest.NewRecorder()

	h.ListConversations(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	convs := body["conversations"].([]interface{})
	if len(convs) != 1 {
		t.Fatalf("expected 1 conversation, got %d", len(convs))
	}
}

func TestAgentChatHandler_CreateConversation_RequiresAuth(t *testing.T) {
	h, _, cleanup := setupAgentChatTest(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/support/agent/conversations", nil)
	w := httptest.NewRecorder()

	h.CreateConversation(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAgentChatHandler_SendMessage_ConflictOnDuplicate(t *testing.T) {
	h, db, cleanup := setupAgentChatTest(t)
	defer cleanup()
	seedUser(t, db, "user-b", "bob")
	seedApp(t, db, "app-2")

	ctx := context.Background()
	if err := h.conversationStore.Create(ctx, &conversation.Conversation{
		ID:           "conv-dup",
		UserID:       "user-b",
		Status:       "active",
		Model:        "test",
		TriggerAppID: "app-2",
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	h.mu.Lock()
	fakeLoop := agent.NewLoop(nil, nil, nil, nil, agent.LoopConfig{MaxTurns: 1}, "token", "user-b", "conv-dup")
	h.activeLoops["conv-dup"] = &agentLoopEntry{loop: fakeLoop, cancel: func() {}}
	h.mu.Unlock()

	body, _ := json.Marshal(map[string]string{"content": "hello"})
	req := httptest.NewRequest(http.MethodPost, "/support/agent/conversations/conv-dup/messages", bytes.NewReader(body))
	req = authCtx(req, "user-b")
	req = withChiURLParam(req, "conversationID", "conv-dup")
	w := httptest.NewRecorder()

	h.SendMessage(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAgentChatHandler_RespondPermission_NotActive(t *testing.T) {
	h, _, cleanup := setupAgentChatTest(t)
	defer cleanup()

	payload := map[string]interface{}{"tool_call_id": "tc-1", "approved": true}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/support/agent/conversations/conv-x/permission", bytes.NewReader(body))
	req = authCtx(req, "user-c")
	req = withChiURLParam(req, "conversationID", "conv-x")
	w := httptest.NewRecorder()

	h.RespondPermission(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestAgentChatHandler_StopConversation(t *testing.T) {
	h, db, cleanup := setupAgentChatTest(t)
	defer cleanup()
	seedUser(t, db, "user-d", "dave")
	seedApp(t, db, "app-3")

	ctx := context.Background()
	if err := h.conversationStore.Create(ctx, &conversation.Conversation{
		ID:           "conv-stop",
		UserID:       "user-d",
		Status:       "active",
		Model:        "test",
		TriggerAppID: "app-3",
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	h.mu.Lock()
	fakeLoop := agent.NewLoop(nil, nil, nil, nil, agent.LoopConfig{MaxTurns: 1}, "token", "user-d", "conv-stop")
	h.activeLoops["conv-stop"] = &agentLoopEntry{loop: fakeLoop, cancel: func() {}}
	h.mu.Unlock()

	req := httptest.NewRequest(http.MethodPost, "/support/agent/conversations/conv-stop/stop", nil)
	req = authCtx(req, "user-d")
	req = withChiURLParam(req, "conversationID", "conv-stop")
	w := httptest.NewRecorder()

	h.StopConversation(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFindPendingProposal_TracksProposals(t *testing.T) {
	h, _, cleanup := setupAgentChatTest(t)
	defer cleanup()

	h.mu.Lock()
	h.activeLoops["conv-1"] = &agentLoopEntry{
		loop:      nil,
		cancel:    func() {},
		proposals: map[string]*agent.ProposalData{"prop-1": {ID: "prop-1", AgentID: "a1"}},
	}
	h.mu.Unlock()

	pd := h.findPendingProposal("conv-1", "prop-1")
	if pd == nil {
		t.Fatal("expected proposal, got nil")
	}
	if pd.ID != "prop-1" {
		t.Fatalf("expected prop-1, got %s", pd.ID)
	}

	missing := h.findPendingProposal("conv-1", "prop-missing")
	if missing != nil {
		t.Fatal("expected nil for missing proposal")
	}
}
