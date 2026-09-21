package security

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

func (s *Service) RecordEvent(ctx context.Context, event *Event) error {
	if event == nil {
		return fmt.Errorf("event cannot be nil")
	}

	// Validate event
	if err := event.Validate(); err != nil {
		return fmt.Errorf("invalid event: %w", err)
	}

	// Set timestamp if not provided
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now().UTC()
	}

	var metadataJSON []byte
	var err error
	if len(event.Metadata) > 0 {
		metadataJSON, err = json.Marshal(event.Metadata)
		if err != nil {
			return fmt.Errorf("marshal metadata: %w", err)
		}
	}

	query := `
		INSERT INTO security_events (timestamp, event_type, severity, actor_id, actor_username, 
		ip_address, user_agent, details, metadata, notified)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id
	`

	row := s.db.QueryRow(query,
		event.Timestamp,
		event.EventType,
		event.Severity,
		event.ActorID,
		event.ActorUsername,
		event.IPAddress,
		event.UserAgent,
		event.Details,
		metadataJSON,
		event.Notified,
	)

	if err := row.Scan(&event.ID); err != nil {
		return fmt.Errorf("insert security event: %w", err)
	}

	s.IncrementEventsRecorded()

	// Queue notification for high-priority events
	if s.shouldNotify(event) {
		select {
		case s.notificationQueue <- event:
		default:
			s.IncrementNotificationsDropped()
			s.logger.Warn("Notification queue full, dropping event",
				"eventType", event.EventType,
			)
		}
	}

	s.logger.Debug("Security event recorded",
		"eventId", event.ID,
		"eventType", event.EventType,
		"actorId", event.ActorID,
	)

	return nil
}

func (s *Service) ListEvents(ctx context.Context, filter EventFilter) (*PaginatedEvents, error) {
	if filter.Limit <= 0 {
		filter.Limit = 100
	}
	if filter.Limit > 1000 {
		filter.Limit = 1000
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}

	var conditions []string
	var args []interface{}

	if filter.ActorID != "" {
		conditions = append(conditions, "actor_id = ?")
		args = append(args, filter.ActorID)
	}
	if filter.EventType != "" {
		conditions = append(conditions, "event_type = ?")
		args = append(args, string(filter.EventType))
	}
	if filter.Severity != "" {
		conditions = append(conditions, "severity = ?")
		args = append(args, string(filter.Severity))
	}
	if !filter.Since.IsZero() {
		conditions = append(conditions, "timestamp >= ?")
		args = append(args, filter.Since)
	}

	whereClause := ""
	if len(conditions) > 0 {
		whereClause = "WHERE " + conditions[0]
		for _, cond := range conditions[1:] {
			whereClause += " AND " + cond
		}
	}

	query := fmt.Sprintf(`
		SELECT id, timestamp, event_type, severity, actor_id, actor_username,
		       ip_address, user_agent, details, metadata, notified
		FROM security_events
		%s
		ORDER BY timestamp DESC
		LIMIT ? OFFSET ?
	`, whereClause)

	args = append(args, filter.Limit, filter.Offset)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query events: %w", err)
	}
	defer rows.Close()

	events, err := s.scanEvents(rows)
	if err != nil {
		return nil, err
	}

	// Get filtered total count
	var totalCount int
	countQuery := fmt.Sprintf(`SELECT COUNT(*) FROM security_events %s`, whereClause)
	countArgs := make([]interface{}, len(args)-2)
	copy(countArgs, args[:len(args)-2])
	err = s.db.QueryRow(countQuery, countArgs...).Scan(&totalCount)
	if err != nil {
		s.logger.Error("Failed to get total event count", "error", err)
	}

	return &PaginatedEvents{
		Events:     events,
		TotalCount: totalCount,
		Limit:      filter.Limit,
		Offset:     filter.Offset,
		HasMore:    filter.Offset+len(events) < totalCount,
	}, nil
}

func (s *Service) scanEvents(rows *sql.Rows) ([]Event, error) {
	events := make([]Event, 0)

	for rows.Next() {
		var event Event
		var metadataJSON []byte

		err := rows.Scan(
			&event.ID,
			&event.Timestamp,
			&event.EventType,
			&event.Severity,
			&event.ActorID,
			&event.ActorUsername,
			&event.IPAddress,
			&event.UserAgent,
			&event.Details,
			&metadataJSON,
			&event.Notified,
		)
		if err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}

		if metadataJSON != nil {
			if err := json.Unmarshal(metadataJSON, &event.Metadata); err != nil {
				s.logger.Error("Failed to unmarshal metadata", "error", err)
			}
		}

		events = append(events, event)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate events: %w", err)
	}

	return events, nil
}

func (s *Service) CleanupOldEvents(ctx context.Context) error {
	cutoff := time.Now().UTC().Add(-time.Duration(s.config.RetentionDays) * 24 * time.Hour)

	query := `DELETE FROM security_events WHERE timestamp < ?`
	result, err := s.db.Exec(query, cutoff)
	if err != nil {
		return fmt.Errorf("delete old events: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		s.logger.Warn("Failed to get rows affected after cleanup", "error", err)
		rowsAffected = 0
	}
	s.logger.Info("Cleaned up old security events", "deleted", rowsAffected, "cutoff", cutoff)

	return nil
}
