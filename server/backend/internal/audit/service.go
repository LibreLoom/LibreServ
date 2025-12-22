package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// Entry represents a single audit log record
type Entry struct {
	ID            int64                  `json:"id"`
	Timestamp     time.Time              `json:"timestamp"`
	ActorID       string                 `json:"actor_id"`
	ActorUsername string                 `json:"actor_username"`
	Action        string                 `json:"action"`
	TargetID      string                 `json:"target_id,omitempty"`
	TargetName    string                 `json:"target_name,omitempty"`
	Status        string                 `json:"status"`
	Message       string                 `json:"message,omitempty"`
	Metadata      map[string]interface{} `json:"metadata,omitempty"`
	IPAddress     string                 `json:"ip_address,omitempty"`
}

// Service handles recording and retrieving audit logs
type Service struct {
	db     *database.DB
	logger *slog.Logger
}

// NewService creates a new audit service
func NewService(db *database.DB) *Service {
	return &Service{
		db:     db,
		logger: slog.Default().With("component", "audit"),
	}
}

// Record logs an administrative action to the database
func (s *Service) Record(ctx context.Context, entry Entry) {
	metadataJSON := "{}"
	if len(entry.Metadata) > 0 {
		if b, err := json.Marshal(entry.Metadata); err == nil {
			metadataJSON = string(b)
		}
	}

	query := `
		INSERT INTO audit_log (
			actor_id, actor_username, action, target_id, target_name, 
			status, message, metadata, ip_address
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	
	_, err := s.db.Exec(query, 
		entry.ActorID, entry.ActorUsername, entry.Action, entry.TargetID, entry.TargetName,
		entry.Status, entry.Message, metadataJSON, entry.IPAddress,
	)

	if err != nil {
		s.logger.Error("Failed to record audit log", "error", err, "action", entry.Action)
	}
}

// List returns audit logs with optional filtering
func (s *Service) List(ctx context.Context, limit int) ([]Entry, error) {
	if limit <= 0 {
		limit = 100
	}

	query := `
		SELECT id, timestamp, actor_id, actor_username, action, target_id, target_name, 
		       status, message, metadata, ip_address
		FROM audit_log
		ORDER BY timestamp DESC
		LIMIT ?
	`
	
	rows, err := s.db.Query(query, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query audit logs: %w", err)
	}
	defer rows.Close()

	var entries []Entry
	for rows.Next() {
		var e Entry
		var metadataStr string
		err := rows.Scan(
			&e.ID, &e.Timestamp, &e.ActorID, &e.ActorUsername, &e.Action, &e.TargetID, &e.TargetName,
			&e.Status, &e.Message, &metadataStr, &e.IPAddress,
		)
		if err != nil {
			s.logger.Warn("Failed to scan audit entry", "error", err)
			continue
		}
		
		_ = json.Unmarshal([]byte(metadataStr), &e.Metadata)
		entries = append(entries, e)
	}

	return entries, nil
}
