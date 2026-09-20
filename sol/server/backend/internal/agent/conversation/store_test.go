package conversation

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func openConversationStore(t *testing.T) (*Store, *database.DB) {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "conversation.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate database: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO users (id, username, password_hash, email, role)
		VALUES ('user-1', 'user1', 'hash', 'user1@example.test', 'user')
	`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO apps (id, name, type, source, path, status, health_status, metadata)
		VALUES ('app-1', 'Demo', 'repo', 'demo', '/tmp/demo', 'running', 'healthy', '{}')
	`); err != nil {
		t.Fatalf("insert app: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewStore(db), db
}

func TestStoreConversationMessageAndEventLifecycle(t *testing.T) {
	store, _ := openConversationStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)

	first := &Conversation{
		ID:             "conversation-1",
		UserID:         "user-1",
		Status:         "active",
		TriggerType:    "app_health",
		TriggerAppID:   "app-1",
		PlanID:         "free",
		PermissionMode: "standard",
		Model:          "model-a",
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := store.Create(ctx, first); err != nil {
		t.Fatalf("create first conversation: %v", err)
	}
	second := &Conversation{
		ID:             "conversation-2",
		UserID:         "user-1",
		Status:         "active",
		TriggerType:    "user_request",
		PlanID:         "plus",
		PermissionMode: "ask",
		Model:          "model-b",
		CreatedAt:      now.Add(time.Second),
		UpdatedAt:      now.Add(time.Second),
	}
	if err := store.Create(ctx, second); err != nil {
		t.Fatalf("create second conversation: %v", err)
	}

	got, err := store.Get(ctx, first.ID)
	if err != nil {
		t.Fatalf("get conversation: %v", err)
	}
	if got.TriggerAppID != "app-1" || got.Model != "model-a" || got.ResolvedAt != nil {
		t.Fatalf("unexpected conversation: %+v", got)
	}
	if _, err := store.Get(ctx, "missing"); err == nil {
		t.Fatal("get missing conversation returned no error")
	}

	toolCalls := json.RawMessage(`[{"id":"call-1"}]`)
	metadata := json.RawMessage(`{"source":"test"}`)
	if err := store.AddMessage(ctx, &Message{
		ID:             "message-1",
		ConversationID: first.ID,
		Role:           "user",
		Content:        "Please repair the app",
		ContentType:    "text",
		Visibility:     "visible",
		ToolCalls:      toolCalls,
		Metadata:       metadata,
		CreatedAt:      now,
	}); err != nil {
		t.Fatalf("add first message: %v", err)
	}
	if err := store.AddMessage(ctx, &Message{
		ID:             "message-2",
		ConversationID: first.ID,
		Role:           "assistant",
		Content:        "Working on it",
		ContentType:    "text",
		Visibility:     "visible",
		CreatedAt:      now.Add(time.Second),
	}); err != nil {
		t.Fatalf("add second message: %v", err)
	}

	messages, err := store.Messages(ctx, first.ID, 0, 0)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(messages) != 2 || string(messages[0].ToolCalls) != string(toolCalls) || string(messages[0].Metadata) != string(metadata) {
		t.Fatalf("unexpected messages: %#v", messages)
	}
	messages, err = store.Messages(ctx, first.ID, 1, 1)
	if err != nil || len(messages) != 1 || messages[0].ID != "message-2" {
		t.Fatalf("paginated messages: %#v, %v", messages, err)
	}

	conversations, err := store.ListByUser(ctx, "user-1", 0, 0)
	if err != nil {
		t.Fatalf("list conversations: %v", err)
	}
	if len(conversations) != 2 {
		t.Fatalf("conversation count = %d", len(conversations))
	}
	var titled *Conversation
	for _, conversation := range conversations {
		if conversation.ID == first.ID {
			titled = conversation
		}
	}
	if titled == nil || titled.Title != "Please repair the app" || titled.TriggerAppID != "app-1" {
		t.Fatalf("first-message title or trigger missing: %+v", titled)
	}
	if limited, err := store.ListByUser(ctx, "user-1", 1000, 1); err != nil || len(limited) != 1 {
		t.Fatalf("capped/offset conversation list: %#v, %v", limited, err)
	}

	active, err := store.FindActiveByApp(ctx, "app-1")
	if err != nil || active == nil || active.ID != first.ID {
		t.Fatalf("find active by app: %+v, %v", active, err)
	}
	active, err = store.FindActiveByTrigger(ctx, "app_health", "app-1")
	if err != nil || active == nil || active.ID != first.ID {
		t.Fatalf("find active by trigger: %+v, %v", active, err)
	}
	if active, err = store.FindActiveByApp(ctx, "missing"); err != nil || active != nil {
		t.Fatalf("missing active app: %+v, %v", active, err)
	}
	if active, err = store.FindActiveByTrigger(ctx, "missing", "missing"); err != nil || active != nil {
		t.Fatalf("missing active trigger: %+v, %v", active, err)
	}

	if err := store.UpdateStatus(ctx, first.ID, "waiting"); err != nil {
		t.Fatalf("update nonterminal status: %v", err)
	}
	if err := store.UpdateStatus(ctx, first.ID, "resolved"); err != nil {
		t.Fatalf("resolve conversation: %v", err)
	}
	got, err = store.Get(ctx, first.ID)
	if err != nil || got.Status != "resolved" || got.ResolvedAt == nil {
		t.Fatalf("resolved conversation: %+v, %v", got, err)
	}
	if active, err = store.FindActiveByApp(ctx, "app-1"); err != nil || active != nil {
		t.Fatalf("resolved conversation remained active: %+v, %v", active, err)
	}

	if err := store.SaveEvent(ctx, first.ID, "started", []byte(`{"step":1}`)); err != nil {
		t.Fatalf("save first event: %v", err)
	}
	if err := store.SaveEvent(ctx, first.ID, "completed", []byte(`{"step":2}`)); err != nil {
		t.Fatalf("save second event: %v", err)
	}
	events, err := store.Events(ctx, first.ID, 10, 0)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) != 2 || events[0].EventType != "started" || events[1].EventData != `{"step":2}` {
		t.Fatalf("unexpected events: %#v", events)
	}
	events, err = store.Events(ctx, first.ID, 1, 1)
	if err != nil || len(events) != 1 || events[0].EventType != "completed" {
		t.Fatalf("paginated events: %#v, %v", events, err)
	}

	if GenerateID() == "" {
		t.Fatal("generated ID is empty")
	}
}

func TestStoreReturnsDatabaseErrors(t *testing.T) {
	store, db := openConversationStore(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conv := &Conversation{ID: "closed", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := store.Create(ctx, conv); err == nil {
		t.Fatal("create on closed database succeeded")
	}
	if _, err := store.ListByUser(ctx, "user-1", 1, 0); err == nil {
		t.Fatal("list conversations on closed database succeeded")
	}
	if err := store.UpdateStatus(ctx, "closed", "resolved"); err == nil {
		t.Fatal("update on closed database succeeded")
	}
	if err := store.AddMessage(ctx, &Message{}); err == nil {
		t.Fatal("add message on closed database succeeded")
	}
	if _, err := store.Messages(ctx, "closed", 1, 0); err == nil {
		t.Fatal("list messages on closed database succeeded")
	}
	if _, err := store.FindActiveByApp(ctx, "closed"); err == nil {
		t.Fatal("find active app on closed database succeeded")
	}
	if _, err := store.FindActiveByTrigger(ctx, "closed", "closed"); err == nil {
		t.Fatal("find active trigger on closed database succeeded")
	}
	if err := store.SaveEvent(ctx, "closed", "event", nil); err == nil {
		t.Fatal("save event on closed database succeeded")
	}
	if _, err := store.Events(ctx, "closed", 1, 0); err == nil {
		t.Fatal("list events on closed database succeeded")
	}
}
