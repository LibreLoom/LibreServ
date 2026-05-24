package conversation

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func setupTestDB(t *testing.T) *database.DB {
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
	return db
}

func seedConversation(t *testing.T, db *database.DB) string {
	t.Helper()
	convID := GenerateID()
	_, err := db.ExecContext(context.Background(), `
		INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		VALUES ('user1', 'testuser', 'hash', 'user', ?, ?)
	`, time.Now(), time.Now())
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	_, err = db.ExecContext(context.Background(), `
		INSERT INTO agent_conversations (id, user_id, status, trigger_type, permission_mode, model, created_at, updated_at)
		VALUES (?, 'user1', 'active', 'manual', 'auto', 'route/mimo-v2.5-pro', ?, ?)
	`, convID, time.Now(), time.Now())
	if err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	return convID
}

func seedMessage(t *testing.T, db *database.DB, convID string) string {
	t.Helper()
	msgID := GenerateID()
	_, err := db.ExecContext(context.Background(), `
		INSERT INTO conversation_messages (id, conversation_id, role, content, content_type, visibility, created_at)
		VALUES (?, ?, 'assistant', '', 'tool_call', 'internal', ?)
	`, msgID, convID, time.Now())
	if err != nil {
		t.Fatalf("seed message: %v", err)
	}
	return msgID
}

func TestToolCallStoreInsert(t *testing.T) {
	db := setupTestDB(t)
	store := NewToolCallStore(db)
	convID := seedConversation(t, db)
	msgID := seedMessage(t, db, convID)

	tc := &ToolCallRecord{
		ID:             "tc_1",
		ConversationID: convID,
		MessageID:      msgID,
		ToolName:       "docker_restart",
		ToolArgs:       json.RawMessage(`{"container":"nginx"}`),
		Status:         "pending",
		CreatedAt:      time.Now(),
	}
	if err := store.Insert(context.Background(), tc); err != nil {
		t.Fatalf("Insert: %v", err)
	}
}

func TestToolCallStoreUpdateResult(t *testing.T) {
	db := setupTestDB(t)
	store := NewToolCallStore(db)
	convID := seedConversation(t, db)
	msgID := seedMessage(t, db, convID)

	tc := &ToolCallRecord{
		ID:             "tc_2",
		ConversationID: convID,
		MessageID:      msgID,
		ToolName:       "docker_ps",
		ToolArgs:       json.RawMessage(`{"all":true}`),
		Status:         "pending",
		CreatedAt:      time.Now(),
	}
	if err := store.Insert(context.Background(), tc); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	if err := store.UpdateResult(context.Background(), "tc_2", "completed", "container nginx running", ""); err != nil {
		t.Fatalf("UpdateResult: %v", err)
	}
}

func TestToolCallStoreUpdateResultFailed(t *testing.T) {
	db := setupTestDB(t)
	store := NewToolCallStore(db)
	convID := seedConversation(t, db)
	msgID := seedMessage(t, db, convID)

	tc := &ToolCallRecord{
		ID:             "tc_3",
		ConversationID: convID,
		MessageID:      msgID,
		ToolName:       "docker_restart",
		ToolArgs:       json.RawMessage(`{"container":"bad-container"}`),
		Status:         "pending",
		CreatedAt:      time.Now(),
	}
	if err := store.Insert(context.Background(), tc); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	if err := store.UpdateResult(context.Background(), "tc_3", "failed", "", "container not found"); err != nil {
		t.Fatalf("UpdateResult failed: %v", err)
	}
}

func TestToolCallStoreUpdateSnapshotID(t *testing.T) {
	db := setupTestDB(t)
	store := NewToolCallStore(db)
	convID := seedConversation(t, db)
	msgID := seedMessage(t, db, convID)

	tc := &ToolCallRecord{
		ID:             "tc_4",
		ConversationID: convID,
		MessageID:      msgID,
		ToolName:       "file_write",
		ToolArgs:       json.RawMessage(`{"path":"/etc/config.yml"}`),
		Status:         "pending",
		CreatedAt:      time.Now(),
	}
	if err := store.Insert(context.Background(), tc); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	if err := store.UpdateSnapshotID(context.Background(), "tc_4", "snap_abc123"); err != nil {
		t.Fatalf("UpdateSnapshotID: %v", err)
	}
}

func TestToolCallStoreUpdateApprovedBy(t *testing.T) {
	db := setupTestDB(t)
	store := NewToolCallStore(db)
	convID := seedConversation(t, db)
	msgID := seedMessage(t, db, convID)

	tc := &ToolCallRecord{
		ID:             "tc_5",
		ConversationID: convID,
		MessageID:      msgID,
		ToolName:       "docker_restart",
		ToolArgs:       json.RawMessage(`{"container":"nginx"}`),
		Status:         "pending",
		CreatedAt:      time.Now(),
	}
	if err := store.Insert(context.Background(), tc); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	if err := store.UpdateApprovedBy(context.Background(), "tc_5", "reviewer"); err != nil {
		t.Fatalf("UpdateApprovedBy: %v", err)
	}
}

func TestToolCallStoreListByConversation(t *testing.T) {
	db := setupTestDB(t)
	store := NewToolCallStore(db)
	convID := seedConversation(t, db)
	msgID := seedMessage(t, db, convID)

	for i := 0; i < 3; i++ {
		tc := &ToolCallRecord{
			ID:             GenerateID(),
			ConversationID: convID,
			MessageID:      msgID,
			ToolName:       "docker_ps",
			ToolArgs:       json.RawMessage(`{}`),
			Status:         "pending",
			CreatedAt:      time.Now(),
		}
		if err := store.Insert(context.Background(), tc); err != nil {
			t.Fatalf("Insert %d: %v", i, err)
		}
	}

	records, err := store.ListByConversation(context.Background(), convID)
	if err != nil {
		t.Fatalf("ListByConversation: %v", err)
	}
	if len(records) != 3 {
		t.Errorf("got %d records, want 3", len(records))
	}
}

func TestToolCallStoreListByConversationEmpty(t *testing.T) {
	db := setupTestDB(t)
	store := NewToolCallStore(db)
	convID := seedConversation(t, db)

	records, err := store.ListByConversation(context.Background(), convID)
	if err != nil {
		t.Fatalf("ListByConversation: %v", err)
	}
	if len(records) != 0 {
		t.Errorf("got %d records, want 0", len(records))
	}
}
