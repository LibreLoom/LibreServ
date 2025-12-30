package network

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// ACMEJobStatus is a coarse-grained state machine for issuance attempts.
type ACMEJobStatus string

// ACMEJobStatus values for issuance lifecycle.
const (
	ACMEJobQueued    ACMEJobStatus = "queued"
	ACMEJobRunning   ACMEJobStatus = "running"
	ACMEJobSucceeded ACMEJobStatus = "succeeded"
	ACMEJobFailed    ACMEJobStatus = "failed"
)

// ACMEJob records an issuance attempt and its outcome.
type ACMEJob struct {
	ID        string        `json:"id"`
	Domain    string        `json:"domain"`
	Email     string        `json:"email"`
	RouteID   string        `json:"route_id,omitempty"`
	Status    ACMEJobStatus `json:"status"`
	Error     string        `json:"error,omitempty"`
	CreatedAt time.Time     `json:"created_at"`
	StartedAt *time.Time    `json:"started_at,omitempty"`
	EndedAt   *time.Time    `json:"ended_at,omitempty"`
}

func ensureACMEJobsTable(db *database.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS acme_jobs (
			id TEXT PRIMARY KEY,
			domain TEXT NOT NULL,
			email TEXT NOT NULL,
			route_id TEXT,
			status TEXT NOT NULL,
			error TEXT,
			created_at TIMESTAMP NOT NULL,
			started_at TIMESTAMP,
			ended_at TIMESTAMP
		)
	`)
	return err
}

// CreateACMEJob inserts a new ACME issuance job.
func CreateACMEJob(ctx context.Context, db *database.DB, domain, email, routeID string) (*ACMEJob, error) {
	if db == nil {
		return nil, fmt.Errorf("db is nil")
	}
	if err := ensureACMEJobsTable(db); err != nil {
		return nil, fmt.Errorf("ensure acme_jobs table: %w", err)
	}
	now := time.Now()
	job := &ACMEJob{
		ID:        uuid.NewString(),
		Domain:    domain,
		Email:     email,
		RouteID:   routeID,
		Status:    ACMEJobQueued,
		CreatedAt: now,
	}
	_, err := db.Exec(
		`INSERT INTO acme_jobs (id, domain, email, route_id, status, error, created_at, started_at, ended_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		job.ID, job.Domain, job.Email, job.RouteID, string(job.Status), job.Error, job.CreatedAt, job.StartedAt, job.EndedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert acme job: %w", err)
	}
	return job, nil
}

// UpdateACMEJobRunning marks an ACME job as running.
func UpdateACMEJobRunning(ctx context.Context, db *database.DB, id string) error {
	if db == nil {
		return fmt.Errorf("db is nil")
	}
	now := time.Now()
	_, err := db.Exec(`UPDATE acme_jobs SET status = ?, started_at = ? WHERE id = ?`, string(ACMEJobRunning), now, id)
	return err
}

// UpdateACMEJobFinished marks an ACME job as finished.
func UpdateACMEJobFinished(ctx context.Context, db *database.DB, id string, success bool, errMsg string) error {
	if db == nil {
		return fmt.Errorf("db is nil")
	}
	now := time.Now()
	status := ACMEJobSucceeded
	if !success {
		status = ACMEJobFailed
	}
	_, err := db.Exec(`UPDATE acme_jobs SET status = ?, error = ?, ended_at = ? WHERE id = ?`, string(status), errMsg, now, id)
	return err
}

// GetACMEJobByID fetches an ACME job by ID.
func GetACMEJobByID(ctx context.Context, db *database.DB, id string) (*ACMEJob, error) {
	if db == nil {
		return nil, fmt.Errorf("db is nil")
	}
	if err := ensureACMEJobsTable(db); err != nil {
		return nil, fmt.Errorf("ensure acme_jobs table: %w", err)
	}
	row := db.QueryRow(
		`SELECT id, domain, email, route_id, status, error, created_at, started_at, ended_at
		 FROM acme_jobs
		 WHERE id = ?`, id,
	)
	var (
		job      ACMEJob
		status   string
		started  *time.Time
		ended    *time.Time
		routeID  *string
		errorMsg *string
	)
	if err := row.Scan(&job.ID, &job.Domain, &job.Email, &routeID, &status, &errorMsg, &job.CreatedAt, &started, &ended); err != nil {
		return nil, err
	}
	job.Status = ACMEJobStatus(status)
	if routeID != nil {
		job.RouteID = *routeID
	}
	if errorMsg != nil {
		job.Error = *errorMsg
	}
	job.StartedAt = started
	job.EndedAt = ended
	return &job, nil
}

// LatestACMEJobForDomain returns the newest job for a domain.
func LatestACMEJobForDomain(ctx context.Context, db *database.DB, domain string) (*ACMEJob, error) {
	if db == nil {
		return nil, fmt.Errorf("db is nil")
	}
	if err := ensureACMEJobsTable(db); err != nil {
		return nil, fmt.Errorf("ensure acme_jobs table: %w", err)
	}
	row := db.QueryRow(
		`SELECT id, domain, email, route_id, status, error, created_at, started_at, ended_at
		 FROM acme_jobs
		 WHERE domain = ?
		 ORDER BY created_at DESC
		 LIMIT 1`, domain,
	)
	var (
		job      ACMEJob
		status   string
		started  *time.Time
		ended    *time.Time
		routeID  *string
		errorMsg *string
	)
	if err := row.Scan(&job.ID, &job.Domain, &job.Email, &routeID, &status, &errorMsg, &job.CreatedAt, &started, &ended); err != nil {
		return nil, err
	}
	job.Status = ACMEJobStatus(status)
	if routeID != nil {
		job.RouteID = *routeID
	}
	if errorMsg != nil {
		job.Error = *errorMsg
	}
	job.StartedAt = started
	job.EndedAt = ended
	return &job, nil
}
