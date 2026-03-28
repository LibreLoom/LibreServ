package handlers

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
)

// JobQueueHandler provides API endpoints for job queue management
type JobQueueHandler struct {
	queue  QueueManager
	logger *slog.Logger
}

// QueueManager interface for job queue operations
type QueueManager interface {
	GetJob(ctx context.Context, jobID string) (jobqueue.JobInfo, error)
	GetLatestJob(ctx context.Context, domain string, jobType jobqueue.JobType) (jobqueue.JobInfo, error)
	GetJobsByStatus(status jobqueue.JobStatus, limit int) ([]*jobqueue.Job, error)
	GetPendingJobs(limit int) ([]*jobqueue.Job, error)
	GetRunningJobs() ([]*jobqueue.Job, error)
	GetQueueStats() (*jobqueue.QueueStats, error)
	CancelJob(jobID string) error
	IsRunning() bool
}

// NewJobQueueHandler creates a new job queue handler
func NewJobQueueHandler(queue QueueManager) *JobQueueHandler {
	return &JobQueueHandler{
		queue:  queue,
		logger: slog.Default().With("component", "job_queue_handler"),
	}
}

// JobResponse represents a job in API responses
type JobResponse struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	Domain      string                 `json:"domain"`
	Email       string                 `json:"email"`
	RouteID     string                 `json:"route_id,omitempty"`
	Status      string                 `json:"status"`
	Priority    int                    `json:"priority"`
	Error       string                 `json:"error,omitempty"`
	RetryCount  int                    `json:"retry_count"`
	MaxRetries  int                    `json:"max_retries"`
	NextRetryAt *time.Time             `json:"next_retry_at,omitempty"`
	CreatedAt   time.Time              `json:"created_at"`
	StartedAt   *time.Time             `json:"started_at,omitempty"`
	EndedAt     *time.Time             `json:"ended_at,omitempty"`
	Logs        []jobqueue.JobLogEntry `json:"logs,omitempty"`
	WebhookURL  string                 `json:"webhook_url,omitempty"`
	WorkerID    string                 `json:"worker_id,omitempty"`
}

// ListJobs handles GET /api/v1/jobs - List jobs with optional filters
func (h *JobQueueHandler) ListJobs(w http.ResponseWriter, r *http.Request) {
	// Parse query parameters
	status := r.URL.Query().Get("status")
	domain := r.URL.Query().Get("domain")
	jobType := r.URL.Query().Get("type")
	limitStr := r.URL.Query().Get("limit")

	limit := 50
	if limitStr != "" {
		if parsedLimit, err := strconv.Atoi(limitStr); err == nil && parsedLimit > 0 && parsedLimit <= 1000 {
			limit = parsedLimit
		}
	}

	var jobs []*jobqueue.Job
	var err error

	ctx := r.Context()

	// Filter by status if provided
	if status != "" {
		jobs, err = h.queue.GetJobsByStatus(jobqueue.JobStatus(status), limit)
		if err != nil {
			// Log detailed error internally, return generic message
			h.logger.Error("failed to get jobs by status", "status", status, "error", err)
			JSONError(w, http.StatusInternalServerError, "failed to retrieve jobs")
			return
		}
	} else if domain != "" {
		// Get latest job for domain
		jobTypeEnum := jobqueue.JobType(jobType)
		jobInfo, err := h.queue.GetLatestJob(ctx, domain, jobTypeEnum)
		if err != nil {
			// Log detailed error internally, return generic message
			h.logger.Error("failed to get latest job", "domain", domain, "error", err)
			JSONError(w, http.StatusInternalServerError, "failed to retrieve job")
			return
		}
		if jobInfo != nil {
			// Type assert to *Job for response conversion
			if job, ok := jobInfo.(*jobqueue.Job); ok {
				jobs = []*jobqueue.Job{job}
			}
		}
	} else {
		// Get pending jobs by default
		jobs, err = h.queue.GetPendingJobs(limit)
		if err != nil {
			// Log detailed error internally, return generic message
			h.logger.Error("failed to get pending jobs", "error", err)
			JSONError(w, http.StatusInternalServerError, "failed to retrieve jobs")
			return
		}
	}

	// Convert to response format
	response := make([]JobResponse, len(jobs))
	for i, job := range jobs {
		response[i] = jobToResponse(job)
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"jobs":  response,
		"count": len(response),
	})
}

// GetJob handles GET /api/v1/jobs/:id - Get job details
func (h *JobQueueHandler) GetJob(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "id")
	if jobID == "" {
		JSONError(w, http.StatusBadRequest, "job ID is required")
		return
	}

	ctx := r.Context()
	jobInfo, err := h.queue.GetJob(ctx, jobID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "job not found")
		return
	}

	// Type assert to *Job for response conversion
	job, ok := jobInfo.(*jobqueue.Job)
	if !ok {
		JSONError(w, http.StatusInternalServerError, "invalid job type")
		return
	}

	JSON(w, http.StatusOK, jobToResponse(job))
}

// GetJobStats handles GET /api/v1/jobs/stats - Get queue statistics
func (h *JobQueueHandler) GetJobStats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.queue.GetQueueStats()
	if err != nil {
		h.logger.Error("failed to get queue stats", "error", err)
		JSONError(w, http.StatusInternalServerError, "failed to retrieve statistics")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"pending":   stats.Pending,
		"queued":    stats.Queued,
		"running":   stats.Running,
		"succeeded": stats.Succeeded,
		"failed":    stats.Failed,
		"total":     stats.Total,
	})
}

// CancelJob handles DELETE /api/v1/jobs/:id - Cancel a pending job
func (h *JobQueueHandler) CancelJob(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "id")
	if jobID == "" {
		JSONError(w, http.StatusBadRequest, "job ID is required")
		return
	}

	err := h.queue.CancelJob(jobID)
	if err != nil {
		// Log detailed error internally
		h.logger.Error("failed to cancel job", "job_id", jobID, "error", err)
		// Return sanitized error message to user
		JSONError(w, http.StatusBadRequest, "failed to cancel job")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message": "job cancelled successfully",
		"job_id":  jobID,
	})
}

// GetRunningJobs handles GET /api/v1/jobs/running - Get currently running jobs
func (h *JobQueueHandler) GetRunningJobs(w http.ResponseWriter, r *http.Request) {
	jobs, err := h.queue.GetRunningJobs()
	if err != nil {
		h.logger.Error("failed to get running jobs", "error", err)
		JSONError(w, http.StatusInternalServerError, "failed to retrieve running jobs")
		return
	}

	// Convert to response format
	response := make([]JobResponse, len(jobs))
	for i, job := range jobs {
		response[i] = jobToResponse(job)
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"jobs":  response,
		"count": len(response),
	})
}

// GetQueueStatus handles GET /api/v1/jobs/status - Get queue operational status
func (h *JobQueueHandler) GetQueueStatus(w http.ResponseWriter, r *http.Request) {
	isRunning := h.queue.IsRunning()

	JSON(w, http.StatusOK, map[string]interface{}{
		"running": isRunning,
		"status":  map[bool]string{true: "operational", false: "stopped"}[isRunning],
	})
}

// jobToResponse converts a Job to JobResponse
func jobToResponse(job *jobqueue.Job) JobResponse {
	return JobResponse{
		ID:          job.ID,
		Type:        string(job.Type),
		Domain:      job.Domain,
		Email:       job.Email,
		RouteID:     job.RouteID,
		Status:      string(job.Status),
		Priority:    int(job.Priority),
		Error:       job.Error,
		RetryCount:  job.RetryCount,
		MaxRetries:  job.MaxRetries,
		NextRetryAt: job.NextRetryAt,
		CreatedAt:   job.CreatedAt,
		StartedAt:   job.StartedAt,
		EndedAt:     job.EndedAt,
		Logs:        job.Logs,
		WebhookURL:  job.WebhookURL,
		WorkerID:    job.WorkerID,
	}
}
