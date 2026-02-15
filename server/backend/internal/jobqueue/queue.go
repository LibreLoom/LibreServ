package jobqueue

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// Queue manages all job worker pools and job lifecycle
type Queue struct {
	db             *database.DB
	webhookService *WebhookService
	pools          map[JobType]*WorkerPool
	handlers       map[JobType]JobHandler
	mu             sync.RWMutex
	logger         *slog.Logger
	stopCh         chan struct{}
	wg             sync.WaitGroup
	retryConfig    RetryConfig
	started        bool
	// In-flight job tracking to prevent zombie job resurrection
	inFlight   map[string]time.Time // jobID -> submit time
	inFlightMu sync.RWMutex
}

// QueueConfig configures the job queue
type QueueConfig struct {
	DB             *database.DB
	WebhookService *WebhookService
	RetryConfig    RetryConfig
}

// NewQueue creates a new job queue manager
func NewQueue(cfg QueueConfig) *Queue {
	if cfg.RetryConfig.InitialBackoff == 0 {
		cfg.RetryConfig = DefaultRetryConfig()
	}

	return &Queue{
		db:             cfg.DB,
		webhookService: cfg.WebhookService,
		pools:          make(map[JobType]*WorkerPool),
		handlers:       make(map[JobType]JobHandler),
		logger:         slog.Default().With("component", "job_queue"),
		stopCh:         make(chan struct{}),
		retryConfig:    cfg.RetryConfig,
		inFlight:       make(map[string]time.Time),
	}
}

// HandlerConfig configures a job handler
type HandlerConfig struct {
	WorkerCount int
	QueueSize   int
}

// RegisterHandler registers a handler for a specific job type
func (q *Queue) RegisterHandler(handler JobHandler, cfg HandlerConfig) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if handler == nil {
		return fmt.Errorf("handler cannot be nil")
	}

	jobType := handler.Type()
	if jobType == "" {
		return fmt.Errorf("handler must return a non-empty job type")
	}

	if _, exists := q.handlers[jobType]; exists {
		return fmt.Errorf("handler already registered for job type: %s", jobType)
	}

	// Validate and set defaults
	if cfg.WorkerCount <= 0 {
		cfg.WorkerCount = DefaultWorkerCount
	}
	if cfg.WorkerCount > 100 {
		return fmt.Errorf("worker count %d exceeds maximum of 100", cfg.WorkerCount)
	}

	if cfg.QueueSize <= 0 {
		cfg.QueueSize = DefaultQueueSize
	}
	if cfg.QueueSize > 10000 {
		return fmt.Errorf("queue size %d exceeds maximum of 10000", cfg.QueueSize)
	}

	q.handlers[jobType] = handler

	// Create worker pool for this job type
	pool := NewWorkerPool(WorkerPoolConfig{
		JobType:        jobType,
		Handler:        handler,
		DB:             q.db,
		WebhookService: q.webhookService,
		WorkerCount:    cfg.WorkerCount,
		QueueSize:      cfg.QueueSize,
		RetryConfig:    q.retryConfig,
		OnJobComplete:  q.RemoveFromInFlight, // Remove from in-flight tracking when job completes
	})

	q.pools[jobType] = pool

	// Start the pool if queue is already running
	if q.started {
		pool.Start()
	}

	q.logger.Info("registered job handler", "job_type", jobType, "workers", cfg.WorkerCount, "queue_size", cfg.QueueSize)
	return nil
}

// Start begins the job queue and all worker pools
func (q *Queue) Start() error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if q.started {
		return fmt.Errorf("queue already started")
	}

	q.logger.Info("starting job queue")

	// Recover any orphaned jobs from previous shutdown
	if err := q.recoverJobs(); err != nil {
		q.logger.Error("failed to recover jobs", "error", err)
		// Continue anyway - we'll pick them up on the next poll
	}

	// Start all worker pools
	for _, pool := range q.pools {
		pool.Start()
	}

	q.started = true

	// Start background job polling
	q.wg.Add(1)
	go q.pollLoop()

	q.logger.Info("job queue started", "pools", len(q.pools))
	return nil
}

// Stop halts the job queue and all worker pools
func (q *Queue) Stop() {
	q.mu.Lock()
	if !q.started {
		q.mu.Unlock()
		return
	}
	q.started = false
	q.mu.Unlock()

	q.logger.Info("stopping job queue")
	close(q.stopCh)

	// Stop all worker pools
	for jobType, pool := range q.pools {
		q.logger.Info("stopping worker pool", "job_type", jobType)
		pool.Stop()
	}

	q.wg.Wait()
	q.logger.Info("job queue stopped")
}

// Enqueue creates and queues a new job
func (q *Queue) Enqueue(jobType JobType, domain, email, routeID string, priority JobPriority) (JobInfo, error) {
	q.mu.RLock()
	_, hasHandler := q.handlers[jobType]
	pool, hasPool := q.pools[jobType]
	q.mu.RUnlock()

	if !hasHandler {
		return nil, fmt.Errorf("no handler registered for job type: %s", jobType)
	}

	ctx := context.Background()
	job, err := CreateJob(ctx, q.db, jobType, domain, email, routeID, priority)
	if err != nil {
		return nil, fmt.Errorf("create job: %w", err)
	}

	job.AddLog("INFO", fmt.Sprintf("Job created (type: %s, priority: %d)", jobType, priority))

	// Submit to worker pool if queue is running
	if q.started && hasPool {
		// Add to in-flight BEFORE submitting to prevent poll loop from picking it up
		q.tryAddInFlight(job.ID)

		if err := pool.Submit(job); err != nil {
			// Pool queue is full, remove from in-flight and let poll loop pick it up
			q.RemoveFromInFlight(job.ID)
			q.logger.Warn("worker pool queue full, job will be picked up by poll loop",
				"job_id", job.ID, "job_type", jobType)
		} else {
			job.Status = JobStatusQueued
			job.AddLog("INFO", "Job queued for processing")
		}
	}

	q.logger.Info("job enqueued",
		"job_id", job.ID,
		"job_type", jobType,
		"domain", domain,
		"priority", priority)

	return job, nil
}

// GetJob retrieves a job by ID
func (q *Queue) GetJob(ctx context.Context, jobID string) (JobInfo, error) {
	return GetJobByID(ctx, q.db, jobID)
}

// GetLatestJob retrieves the latest job for a domain and type
func (q *Queue) GetLatestJob(ctx context.Context, domain string, jobType JobType) (JobInfo, error) {
	return GetLatestJobForDomain(ctx, q.db, domain, jobType)
}

// GetStats retrieves statistics for all pools and queue
func (q *Queue) GetStats() (map[JobType]WorkerStats, *QueueStats, error) {
	q.mu.RLock()
	defer q.mu.RUnlock()

	poolStats := make(map[JobType]WorkerStats)
	for jobType, pool := range q.pools {
		poolStats[jobType] = pool.GetStats()
	}

	ctx := context.Background()
	queueStats, err := GetQueueStats(ctx, q.db)
	if err != nil {
		return nil, nil, err
	}

	return poolStats, queueStats, nil
}

// recoverJobs resets orphaned running jobs and loads pending jobs
func (q *Queue) recoverJobs() error {
	ctx := context.Background()

	// Reset orphaned running jobs to failed status
	if err := ResetOrphanedRunningJobs(ctx, q.db); err != nil {
		return fmt.Errorf("reset orphaned jobs: %w", err)
	}

	// Load any remaining running jobs into in-flight set
	// This handles the case where a restart happened quickly and workers are still processing
	runningJobs, err := GetRunningJobs(ctx, q.db)
	if err != nil {
		return fmt.Errorf("get running jobs: %w", err)
	}

	for _, job := range runningJobs {
		// Add to in-flight with current time
		// These will be subject to stale detection if they don't complete
		q.inFlightMu.Lock()
		q.inFlight[job.ID] = time.Now()
		q.inFlightMu.Unlock()
		q.logger.Info("loaded running job into in-flight set", "job_id", job.ID)
	}

	q.logger.Info("recovered orphaned jobs", "running_jobs_tracked", len(runningJobs))
	return nil
}

// pollLoop periodically polls for pending jobs and distributes them to worker pools
func (q *Queue) pollLoop() {
	defer q.wg.Done()

	ticker := time.NewTicker(DefaultPollInterval)
	defer ticker.Stop()

	// Poll immediately on start
	q.pollPendingJobs()

	for {
		select {
		case <-q.stopCh:
			return
		case <-ticker.C:
			q.pollPendingJobs()
		}
	}
}

// pollPendingJobs fetches pending jobs and submits them to worker pools
func (q *Queue) pollPendingJobs() {
	ctx := context.Background()

	// Clean up stale in-flight entries periodically
	q.cleanupStaleInFlight()

	// Get pending jobs
	jobs, err := GetPendingJobs(ctx, q.db, DefaultPollBatchSize)
	if err != nil {
		q.logger.Error("failed to get pending jobs", "error", err)
		return
	}

	if len(jobs) == 0 {
		return
	}

	q.logger.Debug("polling pending jobs", "count", len(jobs))

	for _, job := range jobs {
		// Check if it's time to retry
		if job.Status == JobStatusFailed && job.NextRetryAt != nil {
			if !ShouldRetryNow(job) {
				continue
			}
		}

		// ATOMIC check-and-add to prevent race conditions
		// This ensures no other goroutine can submit the same job between check and add
		if !q.tryAddInFlight(job.ID) {
			q.logger.Debug("skipping in-flight job", "job_id", job.ID)
			continue
		}

		q.mu.RLock()
		pool, hasPool := q.pools[job.Type]
		q.mu.RUnlock()

		if !hasPool {
			q.logger.Error("no pool for job type, marking failed",
				"job_id", job.ID, "job_type", job.Type)
			// Remove from in-flight since we're not submitting
			q.RemoveFromInFlight(job.ID)
			_ = MarkJobFinished(ctx, q.db, job.ID, false,
				fmt.Sprintf("No handler registered for job type: %s", job.Type), job.Logs)
			continue
		}

		// Submit to worker pool
		if err := pool.Submit(job); err != nil {
			// Remove from in-flight since submission failed
			q.RemoveFromInFlight(job.ID)
			// Pool queue is full, try next job
			q.logger.Debug("worker pool full, skipping job",
				"job_id", job.ID, "job_type", job.Type)
			continue
		}

		// Mark as queued
		if job.Status != JobStatusQueued {
			job.Status = JobStatusQueued
			job.AddLog("INFO", "Job queued for processing")
			// Update logs in DB
			logsJSON, err := job.LogToJSON()
			if err != nil {
				q.logger.Error("failed to marshal logs for job", "job_id", job.ID, "error", err)
			} else {
				_, err = q.db.Exec("UPDATE acme_jobs SET status = ?, logs = ? WHERE id = ?",
					JobStatusQueued, logsJSON, job.ID)
				if err != nil {
					q.logger.Error("failed to update job status in DB", "job_id", job.ID, "error", err)
				}
			}
		}

		q.logger.Debug("submitted job to worker pool",
			"job_id", job.ID, "job_type", job.Type)
	}
}

// tryAddInFlight atomically checks if a job is already in-flight and adds it if not
// Returns true if the job was added (wasn't already in-flight), false otherwise
func (q *Queue) tryAddInFlight(jobID string) bool {
	q.inFlightMu.Lock()
	defer q.inFlightMu.Unlock()

	// Check if already in-flight (and not stale)
	if submitTime, exists := q.inFlight[jobID]; exists {
		// Check if stale (2x timeout)
		if time.Since(submitTime) < 2*DefaultJobTimeout {
			return false // Already in-flight and not stale
		}
		// Stale entry, we'll overwrite it
	}

	// Add to in-flight set
	q.inFlight[jobID] = time.Now()
	return true
}

// RemoveFromInFlight removes a job from the in-flight set (exported for worker.go)
func (q *Queue) RemoveFromInFlight(jobID string) {
	q.inFlightMu.Lock()
	defer q.inFlightMu.Unlock()
	delete(q.inFlight, jobID)
}

// cleanupStaleInFlight removes stale entries from in-flight set
func (q *Queue) cleanupStaleInFlight() {
	q.inFlightMu.Lock()
	defer q.inFlightMu.Unlock()

	staleThreshold := 2 * DefaultJobTimeout
	now := time.Now()
	for jobID, submitTime := range q.inFlight {
		if now.Sub(submitTime) > staleThreshold {
			delete(q.inFlight, jobID)
			q.logger.Warn("removed stale in-flight job", "job_id", jobID, "submitted", submitTime)
		}
	}
}

// IsRunning returns true if the queue is running
func (q *Queue) IsRunning() bool {
	q.mu.RLock()
	defer q.mu.RUnlock()
	return q.started
}

// GetJobsByStatus retrieves jobs by status
func (q *Queue) GetJobsByStatus(status JobStatus, limit int) ([]*Job, error) {
	ctx := context.Background()
	return GetJobsByStatus(ctx, q.db, status, limit)
}

// GetPendingJobs retrieves pending jobs
func (q *Queue) GetPendingJobs(limit int) ([]*Job, error) {
	ctx := context.Background()
	return GetPendingJobs(ctx, q.db, limit)
}

// GetRunningJobs retrieves running jobs
func (q *Queue) GetRunningJobs() ([]*Job, error) {
	ctx := context.Background()
	return GetRunningJobs(ctx, q.db)
}

// GetQueueStats retrieves queue statistics
func (q *Queue) GetQueueStats() (*QueueStats, error) {
	ctx := context.Background()
	return GetQueueStats(ctx, q.db)
}

// CancelJob cancels a pending or queued job
func (q *Queue) CancelJob(jobID string) error {
	ctx := context.Background()
	jobInfo, err := GetJobByID(ctx, q.db, jobID)
	if err != nil {
		return fmt.Errorf("job not found: %w", err)
	}

	// Cast to *Job to access status field
	job, ok := jobInfo.(*Job)
	if !ok {
		return fmt.Errorf("invalid job type")
	}

	if job.Status != JobStatusPending && job.Status != JobStatusQueued {
		return fmt.Errorf("cannot cancel job with status %s (only pending or queued jobs can be cancelled)", job.Status)
	}

	if err := UpdateJobStatus(ctx, q.db, jobID, JobStatusCancelled, "Job cancelled by user"); err != nil {
		return fmt.Errorf("failed to cancel job: %w", err)
	}

	// Remove from in-flight set if present
	q.RemoveFromInFlight(jobID)

	q.logger.Info("job cancelled", "job_id", jobID)
	return nil
}
