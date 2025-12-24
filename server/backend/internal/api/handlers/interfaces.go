package handlers

import "context"

// AuditLogger defines the interface for recording audit logs
type AuditLogger interface {
	Log(ctx context.Context, action, targetID, targetName, status, message string, metadata map[string]interface{})
}
