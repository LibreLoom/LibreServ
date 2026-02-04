package jobqueue

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// JobType represents the type of ACME job
type JobType string

const (
	JobTypeIssuance   JobType = "issuance"
	JobTypeRenewal    JobType = "renewal"
	JobTypeRevocation JobType = "revocation"
	JobTypeValidation JobType = "validation"
)

// JobStatus represents the current state of a job
type JobStatus string

const (
	JobStatusPending   JobStatus = "pending"
	JobStatusQueued    JobStatus = "queued"
	JobStatusRunning   JobStatus = "running"
	JobStatusSucceeded JobStatus = "succeeded"
	JobStatusFailed    JobStatus = "failed"
	JobStatusCancelled JobStatus = "cancelled"
)

// JobPriority represents the priority level of a job (lower number = higher priority)
type JobPriority int

const (
	PriorityCritical JobPriority = 1 // Manual user requests
	PriorityHigh     JobPriority = 3 // Revocations, validations
	PriorityNormal   JobPriority = 5 // Standard issuance
	PriorityLow      JobPriority = 7 // Background renewals
	PriorityLowest   JobPriority = 9 // Maintenance tasks
)

// JobLogEntry represents a single log entry for a job
type JobLogEntry struct {
	Timestamp time.Time `json:"timestamp"`
	Level     string    `json:"level"` // DEBUG, INFO, WARN, ERROR
	Message   string    `json:"message"`
}

// Job represents an ACME operation job
type Job struct {
	ID          string        `json:"id"`
	Type        JobType       `json:"type"`
	Domain      string        `json:"domain"`
	Email       string        `json:"email"`
	RouteID     string        `json:"route_id,omitempty"`
	Status      JobStatus     `json:"status"`
	Priority    JobPriority   `json:"priority"`
	Error       string        `json:"error,omitempty"`
	RetryCount  int           `json:"retry_count"`
	MaxRetries  int           `json:"max_retries"`
	PanicCount  int           `json:"panic_count"`
	NextRetryAt *time.Time    `json:"next_retry_at,omitempty"`
	CreatedAt   time.Time     `json:"created_at"`
	StartedAt   *time.Time    `json:"started_at,omitempty"`
	EndedAt     *time.Time    `json:"ended_at,omitempty"`
	Logs        []JobLogEntry `json:"logs,omitempty"`
	WebhookURL  string        `json:"webhook_url,omitempty"`
	WorkerID    string        `json:"worker_id,omitempty"`
}

// IsTerminal returns true if the job has reached a terminal state
func (j *Job) IsTerminal() bool {
	return j.Status == JobStatusSucceeded || j.Status == JobStatusFailed || j.Status == JobStatusCancelled
}

// GetID returns the job ID for interface compatibility
func (j *Job) GetID() string {
	return j.ID
}

// GetStatus returns the job status for interface compatibility
func (j *Job) GetStatus() string {
	return string(j.Status)
}

// GetDomain returns the domain for interface compatibility
func (j *Job) GetDomain() string {
	return j.Domain
}

// GetType returns the job type for interface compatibility
func (j *Job) GetType() string {
	return string(j.Type)
}

// GetPriority returns the priority for interface compatibility
func (j *Job) GetPriority() int {
	return int(j.Priority)
}

// GetRetryCount returns the retry count for interface compatibility
func (j *Job) GetRetryCount() int {
	return j.RetryCount
}

// GetMaxRetries returns the max retries for interface compatibility
func (j *Job) GetMaxRetries() int {
	return j.MaxRetries
}

// JobInfo interface for job information (satisfies both api and handlers packages)
type JobInfo interface {
	GetID() string
	GetStatus() string
	GetDomain() string
	GetType() string
	GetPriority() int
	GetRetryCount() int
	GetMaxRetries() int
	IsTerminal() bool
}

// CanRetry returns true if the job can be retried
func (j *Job) CanRetry() bool {
	if j.IsTerminal() && j.Status != JobStatusFailed {
		return false
	}
	return j.RetryCount < j.MaxRetries
}

// calculateLogSize estimates the total size of all logs in bytes
// This is a rough estimate based on message lengths plus overhead for timestamps and levels
func (j *Job) calculateLogSize() int {
	total := 0
	for _, entry := range j.Logs {
		// Count message length
		total += len(entry.Message)
		// Add overhead for timestamp (24 bytes for typical RFC3339 string) and level
		total += len(entry.Level) + 24
	}
	return total
}

// truncateMessage truncates a message to MaxLogMessageSize with "..." suffix if needed
func truncateMessage(message string) string {
	if len(message) <= MaxLogMessageSize {
		return message
	}
	if MaxLogMessageSize <= len(TruncateSuffix) {
		return message[:MaxLogMessageSize]
	}
	return message[:MaxLogMessageSize-len(TruncateSuffix)] + TruncateSuffix
}

// AddLog adds a log entry to the job with size limits applied
// Individual messages are truncated to MaxLogMessageSize (1KB)
// Total logs are limited to MaxTotalLogSize (100KB) by removing oldest entries
func (j *Job) AddLog(level, message string) {
	// First, truncate the message if it exceeds MaxLogMessageSize
	truncatedMessage := truncateMessage(message)

	// Calculate size of the new entry (estimate)
	newEntrySize := len(truncatedMessage) + len(level) + 24 // 24 bytes for timestamp overhead

	// Remove oldest logs until we have room for the new entry
	// Also respect MaxJobLogs entry count limit
	for (j.calculateLogSize()+newEntrySize > MaxTotalLogSize || len(j.Logs) >= MaxJobLogs) && len(j.Logs) > 0 {
		// Remove oldest log entry
		j.Logs = j.Logs[1:]
	}

	// Check if we had to remove logs due to entry count limit
	if len(j.Logs) >= MaxJobLogs {
		// This shouldn't happen after the loop above, but handle just in case
		// Remove oldest percentage to make room
		truncateCount := MaxJobLogs * LogTruncatePercentage / 100
		if truncateCount < 1 {
			truncateCount = 1
		}
		j.Logs = j.Logs[truncateCount:]
		j.Logs = append(j.Logs, JobLogEntry{
			Timestamp: time.Now(),
			Level:     "WARN",
			Message:   fmt.Sprintf("Previous %d log entries truncated due to size limit", truncateCount),
		})
	}

	// Add the new log entry
	j.Logs = append(j.Logs, JobLogEntry{
		Timestamp: time.Now(),
		Level:     level,
		Message:   truncatedMessage,
	})
}

// LogToJSON serializes logs to JSON for storage
func (j *Job) LogToJSON() (string, error) {
	if len(j.Logs) == 0 {
		return "[]", nil
	}
	data, err := json.Marshal(j.Logs)
	if err != nil {
		return "", fmt.Errorf("marshal logs: %w", err)
	}
	return string(data), nil
}

// LoadLogsFromJSON deserializes logs from JSON
func (j *Job) LoadLogsFromJSON(data string) error {
	if data == "" || data == "[]" {
		j.Logs = nil
		return nil
	}
	return json.Unmarshal([]byte(data), &j.Logs)
}

// JobHandler is the interface for processing specific job types
type JobHandler interface {
	// Type returns the job type this handler processes
	Type() JobType
	// Process executes the job and returns an error if it fails
	Process(ctx context.Context, job *Job, db *database.DB) error
	// MaxRetries returns the default max retries for this job type
	MaxRetries() int
}

// QueueStats provides statistics about the job queue
type QueueStats struct {
	Pending   int `json:"pending"`
	Queued    int `json:"queued"`
	Running   int `json:"running"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Total     int `json:"total"`
}

// WorkerStats provides statistics about a worker pool
type WorkerStats struct {
	WorkerID      string    `json:"worker_id"`
	JobType       JobType   `json:"job_type"`
	ActiveJobs    int       `json:"active_jobs"`
	ProcessedJobs int64     `json:"processed_jobs"`
	FailedJobs    int64     `json:"failed_jobs"`
	StartedAt     time.Time `json:"started_at"`
}

// DefaultMaxRetries returns the default max retries for a job type
func DefaultMaxRetries(jobType JobType) int {
	switch jobType {
	case JobTypeIssuance:
		return 3
	case JobTypeRenewal:
		return 5 // Renewals are more important, try harder
	case JobTypeRevocation:
		return 2 // Revocations should work quickly
	case JobTypeValidation:
		return 3
	default:
		return 3
	}
}

// DefaultPriority returns the default priority for a job type
func DefaultPriority(jobType JobType) JobPriority {
	switch jobType {
	case JobTypeIssuance:
		return PriorityNormal
	case JobTypeRenewal:
		return PriorityLow
	case JobTypeRevocation:
		return PriorityHigh
	case JobTypeValidation:
		return PriorityHigh
	default:
		return PriorityNormal
	}
}
