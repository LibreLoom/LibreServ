package support

import (
	"context"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// AuditEntry captures a support operation.
type AuditEntry struct {
	ID         int64     `json:"id"`
	SessionID  string    `json:"session_id"`
	Actor      string    `json:"actor"`
	Action     string    `json:"action"`
	Target     string    `json:"target"`
	Success    bool      `json:"success"`
	Message    string    `json:"message,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
}

// AuditLogger writes audit entries to the database.
type AuditLogger struct {
	db *database.DB
}

// NewAuditLogger creates a logger for support audit entries.
func NewAuditLogger(db *database.DB) *AuditLogger {
	return &AuditLogger{db: db}
}

// Log writes a support audit entry to the database.
func (a *AuditLogger) Log(ctx context.Context, entry *AuditEntry) error {
	if entry == nil {
		return nil
	}
	if entry.OccurredAt.IsZero() {
		entry.OccurredAt = time.Now()
	}
	_, err := a.db.Exec(`
		INSERT INTO support_audit (session_id, actor, action, target, success, message, occurred_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, entry.SessionID, entry.Actor, entry.Action, entry.Target, entry.Success, entry.Message, entry.OccurredAt)
	return err
}
