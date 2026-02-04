package jobqueue

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// ensureJobsTable creates the jobs table if it doesn't exist
func ensureJobsTable(db *database.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS acme_jobs (
			id TEXT PRIMARY KEY,
			job_type TEXT NOT NULL DEFAULT 'issuance',
			domain TEXT NOT NULL,
			email TEXT NOT NULL,
			route_id TEXT,
			status TEXT NOT NULL,
			priority INTEGER DEFAULT 5,
			error TEXT,
			retry_count INTEGER DEFAULT 0,
			max_retries INTEGER DEFAULT 3,
			panic_count INTEGER DEFAULT 0,
			next_retry_at TIMESTAMP,
			created_at TIMESTAMP NOT NULL,
			started_at TIMESTAMP,
			ended_at TIMESTAMP,
			logs TEXT,
			webhook_url TEXT,
			worker_id TEXT
		)
	`)
	if err != nil {
		return fmt.Errorf("create acme_jobs table: %w", err)
	}

	// Create indexes for efficient querying
	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_acme_jobs_status ON acme_jobs(status)`,
		`CREATE INDEX IF NOT EXISTS idx_acme_jobs_domain ON acme_jobs(domain)`,
		`CREATE INDEX IF NOT EXISTS idx_acme_jobs_status_type ON acme_jobs(status, job_type)`,
		`CREATE INDEX IF NOT EXISTS idx_acme_jobs_next_retry ON acme_jobs(next_retry_at) WHERE status IN ('pending', 'failed')`,
		`CREATE INDEX IF NOT EXISTS idx_acme_jobs_created ON acme_jobs(created_at DESC)`,
	}

	for _, idx := range indexes {
		if _, err := db.Exec(idx); err != nil {
			return fmt.Errorf("create index: %w", err)
		}
	}

	return nil
}

// validateJobInput validates job input parameters
func validateJobInput(jobType JobType, domain, email string, priority JobPriority) error {
	// Validate job type
	if jobType == "" {
		return fmt.Errorf("job type is required")
	}
	validTypes := map[JobType]bool{
		JobTypeIssuance:   true,
		JobTypeRenewal:    true,
		JobTypeRevocation: true,
		JobTypeValidation: true,
	}
	if !validTypes[jobType] {
		return fmt.Errorf("invalid job type: %s", jobType)
	}

	// Validate domain
	if domain == "" {
		return fmt.Errorf("domain is required")
	}
	if len(domain) > 253 {
		return fmt.Errorf("domain exceeds maximum length of 253 characters")
	}

	// Validate email (basic check)
	if email == "" {
		return fmt.Errorf("email is required")
	}
	if len(email) > 254 {
		return fmt.Errorf("email exceeds maximum length of 254 characters")
	}
	if !strings.Contains(email, "@") {
		return fmt.Errorf("invalid email format: missing @")
	}

	// Validate priority
	if priority < PriorityCritical || priority > PriorityLowest {
		return fmt.Errorf("invalid priority: %d (must be between %d and %d)", priority, PriorityCritical, PriorityLowest)
	}

	return nil
}

// HasPendingOrQueuedJob checks if there's already a pending or queued job for the domain and type
func HasPendingOrQueuedJob(ctx context.Context, db *database.DB, domain string, jobType JobType) (bool, error) {
	if err := ensureJobsTable(db); err != nil {
		return false, err
	}

	var count int
	err := db.QueryRow(`
		SELECT COUNT(*) FROM acme_jobs 
		WHERE domain = ? AND job_type = ? AND status IN ('pending', 'queued', 'running')
	`, domain, jobType).Scan(&count)

	if err != nil {
		return false, fmt.Errorf("check existing jobs: %w", err)
	}

	return count > 0, nil
}

// CreateJob creates a new job in the database after validating the input parameters.
// It assigns a new UUID, sets the initial status to "queued", and determines the
// max retries based on the job type. Returns the created job or an error if validation
// fails or the database operation fails.
// It also checks for duplicate pending/queued jobs for the same domain and type.
func CreateJob(ctx context.Context, db *database.DB, jobType JobType, domain, email, routeID string, priority JobPriority) (*Job, error) {
	// Validate inputs
	if err := validateJobInput(jobType, domain, email, priority); err != nil {
		return nil, fmt.Errorf("validation failed: %w", err)
	}

	if err := ensureJobsTable(db); err != nil {
		return nil, err
	}

	// Check for duplicate pending/queued jobs
	hasExisting, err := HasPendingOrQueuedJob(ctx, db, domain, jobType)
	if err != nil {
		return nil, fmt.Errorf("check for existing job: %w", err)
	}
	if hasExisting {
		return nil, fmt.Errorf("job already pending or in progress for domain %s (type: %s)", domain, jobType)
	}

	job := &Job{
		ID:         uuid.NewString(),
		Type:       jobType,
		Domain:     domain,
		Email:      email,
		RouteID:    routeID,
		Status:     JobStatusQueued,
		Priority:   priority,
		MaxRetries: DefaultMaxRetries(jobType),
		CreatedAt:  time.Now(),
		Logs:       nil, // Zero-allocation, marshals to "[]"
	}

	logsJSON, err := job.LogToJSON()
	if err != nil {
		return nil, fmt.Errorf("marshal logs: %w", err)
	}

	_, err = db.Exec(`
		INSERT INTO acme_jobs (id, job_type, domain, email, route_id, status, priority, 
			error, retry_count, max_retries, panic_count, next_retry_at, created_at, started_at, ended_at, logs, webhook_url, worker_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		job.ID, job.Type, job.Domain, job.Email, job.RouteID, job.Status, job.Priority,
		job.Error, job.RetryCount, job.MaxRetries, job.PanicCount, nil, job.CreatedAt, nil, nil, logsJSON, job.WebhookURL, job.WorkerID,
	)
	if err != nil {
		return nil, fmt.Errorf("insert job: %w", err)
	}

	return job, nil
}

// GetJobByID retrieves a job by its unique ID. Returns the job as JobInfo interface
// or an error if the job is not found or the database operation fails.
func GetJobByID(ctx context.Context, db *database.DB, id string) (JobInfo, error) {
	if err := ensureJobsTable(db); err != nil {
		return nil, err
	}

	row := db.QueryRow(`
		SELECT id, job_type, domain, email, route_id, status, priority, error, 
			retry_count, max_retries, panic_count, next_retry_at, created_at, started_at, ended_at, logs, webhook_url, worker_id
		FROM acme_jobs WHERE id = ?`, id)

	return scanJob(row)
}

// GetPendingJobs retrieves all pending jobs (including queued jobs and failed jobs
// eligible for retry) ordered by priority (ascending) and creation time (ascending).
// The limit parameter controls the maximum number of jobs returned.
func GetPendingJobs(ctx context.Context, db *database.DB, limit int) ([]*Job, error) {
	if err := ensureJobsTable(db); err != nil {
		return nil, err
	}

	rows, err := db.Query(`
		SELECT id, job_type, domain, email, route_id, status, priority, error, 
			retry_count, max_retries, panic_count, next_retry_at, created_at, started_at, ended_at, logs, webhook_url, worker_id
		FROM acme_jobs 
		WHERE status IN ('pending', 'queued') 
			OR (status = 'failed' AND retry_count < max_retries AND panic_count < ? AND (next_retry_at IS NULL OR next_retry_at <= ?))
		ORDER BY priority ASC, created_at ASC
		LIMIT ?`, MaxPanicRetries, time.Now(), limit)
	if err != nil {
		return nil, fmt.Errorf("query pending jobs: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			log.Printf("failed to close rows: %v", cerr)
		}
	}()

	return scanJobs(rows)
}

// GetJobsByStatus retrieves all jobs with the specified status, ordered by creation
// time in descending order (most recent first). The limit parameter controls the
// maximum number of jobs returned.
func GetJobsByStatus(ctx context.Context, db *database.DB, status JobStatus, limit int) ([]*Job, error) {
	if err := ensureJobsTable(db); err != nil {
		return nil, err
	}

	rows, err := db.Query(`
		SELECT id, job_type, domain, email, route_id, status, priority, error, 
			retry_count, max_retries, panic_count, next_retry_at, created_at, started_at, ended_at, logs, webhook_url, worker_id
		FROM acme_jobs 
		WHERE status = ?
		ORDER BY created_at DESC
		LIMIT ?`, status, limit)
	if err != nil {
		return nil, fmt.Errorf("query jobs by status: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			log.Printf("failed to close rows: %v", cerr)
		}
	}()

	return scanJobs(rows)
}

// GetRunningJobs retrieves all jobs currently in "running" status. This is useful
// for monitoring and for recovery operations after a system restart.
func GetRunningJobs(ctx context.Context, db *database.DB) ([]*Job, error) {
	return GetJobsByStatus(ctx, db, JobStatusRunning, MaxRunningJobsQueryLimit)
}

// GetLatestJobForDomain retrieves the most recent job for a specific domain and
// optionally filtered by job type. If jobType is empty, it returns the latest job
// of any type for the domain.
func GetLatestJobForDomain(ctx context.Context, db *database.DB, domain string, jobType JobType) (JobInfo, error) {
	if err := ensureJobsTable(db); err != nil {
		return nil, err
	}

	query := `
		SELECT id, job_type, domain, email, route_id, status, priority, error, 
			retry_count, max_retries, panic_count, next_retry_at, created_at, started_at, ended_at, logs, webhook_url, worker_id
		FROM acme_jobs 
		WHERE domain = ?`
	args := []interface{}{domain}

	if jobType != "" {
		query += ` AND job_type = ?`
		args = append(args, jobType)
	}

	query += ` ORDER BY created_at DESC LIMIT 1`

	row := db.QueryRow(query, args...)
	return scanJob(row)
}

// UpdateJobStatus updates the status and error message of a job, and sets the
// ended_at timestamp to the current time. This is typically used for simple
// status transitions that don't require additional metadata updates.
func UpdateJobStatus(ctx context.Context, db *database.DB, jobID string, status JobStatus, error string) error {
	_, err := db.Exec(`
		UPDATE acme_jobs 
		SET status = ?, error = ?, ended_at = ?
		WHERE id = ?`,
		status, error, time.Now(), jobID)
	if err != nil {
		return fmt.Errorf("update job %s status: %w", jobID, err)
	}
	return nil
}

// MarkJobRunning marks a job as "running", assigns it to a specific worker,
// and sets the started_at timestamp. This clears any previous ended_at timestamp.
func MarkJobRunning(ctx context.Context, db *database.DB, jobID, workerID string) error {
	now := time.Now()
	_, err := db.Exec(`
		UPDATE acme_jobs 
		SET status = ?, worker_id = ?, started_at = ?, ended_at = NULL
		WHERE id = ?`,
		JobStatusRunning, workerID, now, jobID)
	if err != nil {
		return fmt.Errorf("mark job %s as running: %w", jobID, err)
	}
	return nil
}

// MarkJobFinished marks a job as completed with either "succeeded" or "failed" status,
// stores the error message (if any), sets the ended_at timestamp, persists the logs,
// and clears the worker assignment. Returns an error if log marshaling or database
// update fails.
func MarkJobFinished(ctx context.Context, db *database.DB, jobID string, success bool, error string, logs []JobLogEntry) error {
	now := time.Now()
	status := JobStatusSucceeded
	if !success {
		status = JobStatusFailed
	}

	logsJSON, err := json.Marshal(logs)
	if err != nil {
		return fmt.Errorf("marshal logs for job %s: %w", jobID, err)
	}

	_, err = db.Exec(`
		UPDATE acme_jobs 
		SET status = ?, error = ?, ended_at = ?, logs = ?, worker_id = NULL
		WHERE id = ?`,
		status, error, now, string(logsJSON), jobID)
	if err != nil {
		return fmt.Errorf("mark job %s as finished: %w", jobID, err)
	}
	return nil
}

// MarkJobForRetry marks a job as "pending" for retry, updates the retry count,
// sets the next retry time, stores the error message and logs, and clears the
// worker assignment. Returns an error if log marshaling or database update fails.
func MarkJobForRetry(ctx context.Context, db *database.DB, jobID string, retryCount int, nextRetryAt time.Time, error string, logs []JobLogEntry) error {
	logsJSON, err := json.Marshal(logs)
	if err != nil {
		return fmt.Errorf("marshal logs for job %s: %w", jobID, err)
	}

	_, err = db.Exec(`
		UPDATE acme_jobs 
		SET status = ?, retry_count = ?, next_retry_at = ?, error = ?, logs = ?, worker_id = NULL
		WHERE id = ?`,
		JobStatusPending, retryCount, nextRetryAt, error, string(logsJSON), jobID)
	if err != nil {
		return fmt.Errorf("mark job %s for retry: %w", jobID, err)
	}
	return nil
}

// ResetOrphanedRunningJobs resets all jobs that were in "running" status to
// "failed" with an appropriate error message. This is called on system startup
// to handle jobs that were interrupted by a crash or shutdown.
func ResetOrphanedRunningJobs(ctx context.Context, db *database.DB) error {
	_, err := db.Exec(`
		UPDATE acme_jobs 
		SET status = ?, worker_id = NULL, error = 'Job was orphaned after system restart'
		WHERE status = ?`,
		JobStatusFailed, JobStatusRunning)
	if err != nil {
		return fmt.Errorf("reset orphaned running jobs: %w", err)
	}
	return nil
}

// IncrementJobPanicCount increments the panic count for a job and returns the new count.
// If the count exceeds MaxPanicRetries, it marks the job as failed permanently.
func IncrementJobPanicCount(ctx context.Context, db *database.DB, jobID string, panicMsg string, logs []JobLogEntry) (int, bool, error) {
	logsJSON, err := json.Marshal(logs)
	if err != nil {
		return 0, false, fmt.Errorf("marshal logs for job %s: %w", jobID, err)
	}

	// First, increment the panic count and get the new value
	_, err = db.Exec(`
		UPDATE acme_jobs 
		SET panic_count = panic_count + 1, logs = ?, worker_id = NULL
		WHERE id = ?`,
		string(logsJSON), jobID)
	if err != nil {
		return 0, false, fmt.Errorf("increment panic count for job %s: %w", jobID, err)
	}

	// Get the updated panic count
	var panicCount int
	err = db.QueryRow(`SELECT panic_count FROM acme_jobs WHERE id = ?`, jobID).Scan(&panicCount)
	if err != nil {
		return 0, false, fmt.Errorf("get panic count for job %s: %w", jobID, err)
	}

	// Check if we've exceeded the max panic retries
	if panicCount >= MaxPanicRetries {
		// Mark job as failed permanently
		_, err = db.Exec(`
			UPDATE acme_jobs 
			SET status = ?, error = ?, ended_at = ?, worker_id = NULL
			WHERE id = ?`,
			JobStatusFailed, panicMsg, time.Now(), jobID)
		if err != nil {
			return panicCount, false, fmt.Errorf("mark job %s as failed after max panics: %w", jobID, err)
		}
		return panicCount, true, nil // true = marked as failed
	}

	// Mark job as pending for retry
	_, err = db.Exec(`
		UPDATE acme_jobs 
		SET status = ?, error = ?, worker_id = NULL
		WHERE id = ?`,
		JobStatusPending, panicMsg, jobID)
	if err != nil {
		return panicCount, false, fmt.Errorf("mark job %s as pending after panic: %w", jobID, err)
	}

	return panicCount, false, nil // false = not yet marked as failed
}

// GetQueueStats retrieves aggregate statistics about the job queue for the last
// 7 days, including counts of jobs by status (pending, running, succeeded, failed).
// Returns a QueueStats struct with the aggregated counts.
func GetQueueStats(ctx context.Context, db *database.DB) (*QueueStats, error) {
	if err := ensureJobsTable(db); err != nil {
		return nil, err
	}

	stats := &QueueStats{}

	// Count by status
	rows, err := db.Query(`
		SELECT status, COUNT(*) 
		FROM acme_jobs 
		WHERE created_at > datetime('now', '-7 days')
		GROUP BY status`)
	if err != nil {
		return nil, fmt.Errorf("query stats: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			log.Printf("failed to close rows: %v", cerr)
		}
	}()

	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			continue
		}
		switch JobStatus(status) {
		case JobStatusPending, JobStatusQueued:
			stats.Pending += count
		case JobStatusRunning:
			stats.Running = count
		case JobStatusSucceeded:
			stats.Succeeded = count
		case JobStatusFailed:
			stats.Failed = count
		}
	}

	// Total pending/running
	stats.Total = stats.Pending + stats.Running

	return stats, nil
}

// scanJob scans a single job from a row
func scanJob(row *sql.Row) (*Job, error) {
	var job Job
	var status, jobType string
	var errorMsg, routeID, webhookURL, workerID *string
	var startedAt, endedAt, nextRetryAt *time.Time
	var logsJSON string

	err := row.Scan(
		&job.ID, &jobType, &job.Domain, &job.Email, &routeID, &status, &job.Priority,
		&errorMsg, &job.RetryCount, &job.MaxRetries, &job.PanicCount, &nextRetryAt,
		&job.CreatedAt, &startedAt, &endedAt, &logsJSON, &webhookURL, &workerID,
	)
	if err != nil {
		return nil, err
	}

	job.Type = JobType(jobType)
	job.Status = JobStatus(status)
	if errorMsg != nil {
		job.Error = *errorMsg
	}
	if routeID != nil {
		job.RouteID = *routeID
	}
	if webhookURL != nil {
		job.WebhookURL = *webhookURL
	}
	if workerID != nil {
		job.WorkerID = *workerID
	}
	job.StartedAt = startedAt
	job.EndedAt = endedAt
	job.NextRetryAt = nextRetryAt

	if logsJSON != "" {
		_ = job.LoadLogsFromJSON(logsJSON)
	}

	return &job, nil
}

// scanJobs scans multiple jobs from rows
func scanJobs(rows *sql.Rows) ([]*Job, error) {
	var jobs []*Job

	for rows.Next() {
		var job Job
		var status, jobType string
		var errorMsg, routeID, webhookURL, workerID *string
		var startedAt, endedAt, nextRetryAt *time.Time
		var logsJSON string

		err := rows.Scan(
			&job.ID, &jobType, &job.Domain, &job.Email, &routeID, &status, &job.Priority,
			&errorMsg, &job.RetryCount, &job.MaxRetries, &job.PanicCount, &nextRetryAt,
			&job.CreatedAt, &startedAt, &endedAt, &logsJSON, &webhookURL, &workerID,
		)
		if err != nil {
			return nil, err
		}

		job.Type = JobType(jobType)
		job.Status = JobStatus(status)
		if errorMsg != nil {
			job.Error = *errorMsg
		}
		if routeID != nil {
			job.RouteID = *routeID
		}
		if webhookURL != nil {
			job.WebhookURL = *webhookURL
		}
		if workerID != nil {
			job.WorkerID = *workerID
		}
		job.StartedAt = startedAt
		job.EndedAt = endedAt
		job.NextRetryAt = nextRetryAt

		if logsJSON != "" {
			_ = job.LoadLogsFromJSON(logsJSON)
		}

		jobs = append(jobs, &job)
	}

	return jobs, rows.Err()
}
