package conversation

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type Conversation struct {
	ID             string     `json:"id"`
	UserID         string     `json:"user_id"`
	Status         string     `json:"status"`
	TriggerType    string     `json:"trigger_type"`
	TriggerAppID   string     `json:"trigger_app_id,omitempty"`
	PlanID         string     `json:"plan_id"`
	PermissionMode string     `json:"permission_mode"`
	Model          string     `json:"model"`
	Title          string     `json:"title,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	ResolvedAt     *time.Time `json:"resolved_at,omitempty"`
}

type Message struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversation_id"`
	Role           string          `json:"role"`
	Content        string          `json:"content"`
	ContentType    string          `json:"content_type"`
	Visibility     string          `json:"visibility"`
	ToolCalls      json.RawMessage `json:"tool_calls,omitempty"`
	Metadata       json.RawMessage `json:"metadata,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
}

type Store struct {
	db *database.DB
}

func NewStore(db *database.DB) *Store {
	return &Store{db: db}
}

func (s *Store) Create(ctx context.Context, conv *Conversation) error {
	var triggerAppID interface{}
	if conv.TriggerAppID != "" {
		triggerAppID = conv.TriggerAppID
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO agent_conversations (id, user_id, status, trigger_type, trigger_app_id, plan_id, permission_mode, model, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, conv.ID, conv.UserID, conv.Status, conv.TriggerType, triggerAppID, conv.PlanID, conv.PermissionMode, conv.Model, conv.CreatedAt, conv.UpdatedAt)
	return err
}

func (s *Store) Get(ctx context.Context, id string) (*Conversation, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, status, trigger_type, trigger_app_id, plan_id, permission_mode, model, created_at, updated_at, resolved_at
		FROM agent_conversations WHERE id = ?
	`, id)

	var c Conversation
	var triggerAppID sql.NullString
	var resolvedAt sql.NullTime
	if err := row.Scan(&c.ID, &c.UserID, &c.Status, &c.TriggerType, &triggerAppID, &c.PlanID, &c.PermissionMode, &c.Model, &c.CreatedAt, &c.UpdatedAt, &resolvedAt); err != nil {
		return nil, err
	}
	if triggerAppID.Valid {
		c.TriggerAppID = triggerAppID.String
	}
	if resolvedAt.Valid {
		c.ResolvedAt = &resolvedAt.Time
	}
	return &c, nil
}

func (s *Store) ListByUser(ctx context.Context, userID string, limit, offset int) ([]*Conversation, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.id, c.user_id, c.status, c.trigger_type, c.trigger_app_id, c.plan_id, c.permission_mode, c.model, c.created_at, c.updated_at, c.resolved_at,
			COALESCE((SELECT content FROM conversation_messages WHERE conversation_id = c.id AND role = 'user' AND visibility = 'visible' ORDER BY created_at ASC LIMIT 1), '') as first_message
		FROM agent_conversations c
		WHERE c.user_id = ?
		ORDER BY c.created_at DESC
		LIMIT ? OFFSET ?
	`, userID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var convs []*Conversation
	for rows.Next() {
		var c Conversation
		var triggerAppID sql.NullString
		var resolvedAt sql.NullTime
		var firstMsg sql.NullString
		if err := rows.Scan(&c.ID, &c.UserID, &c.Status, &c.TriggerType, &triggerAppID, &c.PlanID, &c.PermissionMode, &c.Model, &c.CreatedAt, &c.UpdatedAt, &resolvedAt, &firstMsg); err != nil {
			return nil, fmt.Errorf("scan conversation row: %w", err)
		}
		if firstMsg.Valid && firstMsg.String != "" {
			c.Title = firstMsg.String
		}
		if triggerAppID.Valid {
			c.TriggerAppID = triggerAppID.String
		}
		if resolvedAt.Valid {
			c.ResolvedAt = &resolvedAt.Time
		}
		convs = append(convs, &c)
	}
	return convs, nil
}

func (s *Store) UpdateStatus(ctx context.Context, id, status string) error {
	now := time.Now()
	var resolvedAt *time.Time
	if status == "resolved" || status == "cancelled" {
		resolvedAt = &now
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE agent_conversations SET status = ?, updated_at = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?
	`, status, now, resolvedAt, id)
	return err
}

func (s *Store) AddMessage(ctx context.Context, msg *Message) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO conversation_messages (id, conversation_id, role, content, content_type, visibility, tool_calls, metadata, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, msg.ID, msg.ConversationID, msg.Role, msg.Content, msg.ContentType, msg.Visibility, msg.ToolCalls, msg.Metadata, msg.CreatedAt)
	return err
}

func (s *Store) Messages(ctx context.Context, conversationID string, limit, offset int) ([]*Message, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, conversation_id, role, content, content_type, visibility, tool_calls, metadata, created_at
		FROM conversation_messages
		WHERE conversation_id = ?
		ORDER BY created_at ASC
		LIMIT ? OFFSET ?
	`, conversationID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []*Message
	for rows.Next() {
		var m Message
		var toolCallsJSON sql.NullString
		var metadataJSON sql.NullString
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.ContentType, &m.Visibility, &toolCallsJSON, &metadataJSON, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan message row: %w", err)
		}
		if toolCallsJSON.Valid {
			m.ToolCalls = json.RawMessage(toolCallsJSON.String)
		}
		if metadataJSON.Valid {
			m.Metadata = json.RawMessage(metadataJSON.String)
		}
		msgs = append(msgs, &m)
	}
	return msgs, nil
}

func (s *Store) FindActiveByApp(ctx context.Context, appID string) (*Conversation, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, status, trigger_type, trigger_app_id, plan_id, permission_mode, model, created_at, updated_at, resolved_at
		FROM agent_conversations
		WHERE trigger_app_id = ? AND status = 'active'
		ORDER BY created_at DESC
		LIMIT 1
	`, appID)

	var c Conversation
	var triggerAppID sql.NullString
	var resolvedAt sql.NullTime
	if err := row.Scan(&c.ID, &c.UserID, &c.Status, &c.TriggerType, &triggerAppID, &c.PlanID, &c.PermissionMode, &c.Model, &c.CreatedAt, &c.UpdatedAt, &resolvedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if triggerAppID.Valid {
		c.TriggerAppID = triggerAppID.String
	}
	if resolvedAt.Valid {
		c.ResolvedAt = &resolvedAt.Time
	}
	return &c, nil
}

func GenerateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func (s *Store) FindActiveByTrigger(ctx context.Context, triggerType, triggerAppID string) (*Conversation, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, status, trigger_type, trigger_app_id, plan_id, permission_mode, model, created_at, updated_at, resolved_at
		FROM agent_conversations
		WHERE trigger_type = ? AND trigger_app_id = ? AND status = 'active'
		ORDER BY created_at DESC
		LIMIT 1
	`, triggerType, triggerAppID)

	var c Conversation
	var appID sql.NullString
	var resolvedAt sql.NullTime
	if err := row.Scan(&c.ID, &c.UserID, &c.Status, &c.TriggerType, &appID, &c.PlanID, &c.PermissionMode, &c.Model, &c.CreatedAt, &c.UpdatedAt, &resolvedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if appID.Valid {
		c.TriggerAppID = appID.String
	}
	if resolvedAt.Valid {
		c.ResolvedAt = &resolvedAt.Time
	}
	return &c, nil
}

// EventRecord mirrors a single agent event for persistence.
type EventRecord struct {
	ID             int64     `json:"id"`
	ConversationID string    `json:"conversation_id"`
	EventType      string    `json:"event_type"`
	EventData      string    `json:"event_data"`
	CreatedAt      time.Time `json:"created_at"`
}

func (s *Store) SaveEvent(ctx context.Context, convID, eventType string, eventData []byte) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO conversation_events (conversation_id, event_type, event_data)
		VALUES (?, ?, ?)
	`, convID, eventType, string(eventData))
	return err
}

func (s *Store) Events(ctx context.Context, convID string, limit, offset int) ([]EventRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, conversation_id, event_type, event_data, created_at
		FROM conversation_events
		WHERE conversation_id = ?
		ORDER BY id ASC
		LIMIT ? OFFSET ?
	`, convID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []EventRecord
	for rows.Next() {
		var r EventRecord
		if err := rows.Scan(&r.ID, &r.ConversationID, &r.EventType, &r.EventData, &r.CreatedAt); err != nil {
			return nil, err
		}
		records = append(records, r)
	}
	return records, rows.Err()
}
