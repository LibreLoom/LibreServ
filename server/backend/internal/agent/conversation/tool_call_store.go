package conversation

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type ToolCallRecord struct {
	ID             string
	ConversationID string
	MessageID      string
	ToolName       string
	ToolArgs       json.RawMessage
	Status         string
	Result         string
	Error          string
	SnapshotID     string
	ApprovedBy     string
	CreatedAt      time.Time
	ExecutedAt     *time.Time
}

type ToolCallStore struct {
	db *database.DB
}

func NewToolCallStore(db *database.DB) *ToolCallStore {
	return &ToolCallStore{db: db}
}

func (s *ToolCallStore) Insert(ctx context.Context, tc *ToolCallRecord) error {
	var executedAt sql.NullTime
	if tc.ExecutedAt != nil {
		executedAt = sql.NullTime{Time: *tc.ExecutedAt, Valid: true}
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO tool_calls (id, conversation_id, message_id, tool_name, tool_args, status, result, error, snapshot_id, approved_by, created_at, executed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO NOTHING
	`, tc.ID, tc.ConversationID, tc.MessageID, tc.ToolName, string(tc.ToolArgs), tc.Status, tc.Result, tc.Error, tc.SnapshotID, tc.ApprovedBy, tc.CreatedAt, executedAt)
	if err != nil {
		return fmt.Errorf("insert tool_call: %w", err)
	}
	return nil
}

func (s *ToolCallStore) UpdateResult(ctx context.Context, id, status, result, errStr string) error {
	now := time.Now()
	_, dbErr := s.db.ExecContext(ctx, `
		UPDATE tool_calls SET status = ?, result = ?, error = ?, executed_at = ? WHERE id = ?
	`, status, result, errStr, now, id)
	if dbErr != nil {
		return fmt.Errorf("update tool_call: %w", dbErr)
	}
	return nil
}

func (s *ToolCallStore) ListByConversation(ctx context.Context, convID string) ([]*ToolCallRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, conversation_id, message_id, tool_name, tool_args, status, result, error, snapshot_id, approved_by, created_at, executed_at
		FROM tool_calls WHERE conversation_id = ? ORDER BY created_at
	`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var records []*ToolCallRecord
	for rows.Next() {
		var tc ToolCallRecord
		var executedAt sql.NullTime
		var toolArgs string
		if err := rows.Scan(&tc.ID, &tc.ConversationID, &tc.MessageID, &tc.ToolName, &toolArgs, &tc.Status, &tc.Result, &tc.Error, &tc.SnapshotID, &tc.ApprovedBy, &tc.CreatedAt, &executedAt); err != nil {
			continue
		}
		tc.ToolArgs = json.RawMessage(toolArgs)
		if executedAt.Valid {
			tc.ExecutedAt = &executedAt.Time
		}
		records = append(records, &tc)
	}
	return records, nil
}
