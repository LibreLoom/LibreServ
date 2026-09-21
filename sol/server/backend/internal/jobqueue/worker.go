package jobqueue

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// WorkerPool manages a pool of workers for a specific job type
type WorkerPool struct {
	jobType         JobType
	handler         JobHandler
	db              *database.DB
	webhookService  *WebhookService
	workerCount     int
	queue           chan *Job
	activeJobs      map[string]*Job      // jobID -> job
	activeStartTime map[string]time.Time // jobID -> start time
	mu              sync.RWMutex
	stopCh          chan struct{}
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
	logger          *slog.Logger
	workerID        string
	processedCount  int64
	failedCount     int64
	startedAt       time.Time
	retryConfig     RetryConfig
	onJobComplete   func(jobID string) // callback to remove job from in-flight tracking
}

// WorkerPoolConfig configures a worker pool
type WorkerPoolConfig struct {
	JobType        JobType
	Handler        JobHandler
	DB             *database.DB
	WebhookService *WebhookService
	WorkerCount    int
	QueueSize      int
	RetryConfig    RetryConfig
	OnJobComplete  func(jobID string) // callback to remove job from in-flight tracking
}

// NewWorkerPool creates a new worker pool for a specific job type
func NewWorkerPool(cfg WorkerPoolConfig) *WorkerPool {
	if cfg.WorkerCount <= 0 {
		cfg.WorkerCount = DefaultWorkerCount
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = DefaultQueueSize
	}
	if cfg.RetryConfig.InitialBackoff == 0 {
		cfg.RetryConfig = DefaultRetryConfig()
	}

	return &WorkerPool{
		jobType:         cfg.JobType,
		handler:         cfg.Handler,
		db:              cfg.DB,
		webhookService:  cfg.WebhookService,
		workerCount:     cfg.WorkerCount,
		queue:           make(chan *Job, cfg.QueueSize),
		activeJobs:      make(map[string]*Job),
		activeStartTime: make(map[string]time.Time),
		stopCh:          make(chan struct{}),
		logger:          slog.Default().With("component", "worker_pool", "job_type", cfg.JobType),
		workerID:        fmt.Sprintf("%s-%d", cfg.JobType, time.Now().UnixNano()),
		startedAt:       time.Now(),
		retryConfig:     cfg.RetryConfig,
		onJobComplete:   cfg.OnJobComplete,
	}
}

// Start begins the worker pool
func (wp *WorkerPool) Start() {
	wp.logger.Info("starting worker pool", "workers", wp.workerCount)

	// Create a context for the pool that can be cancelled
	wp.ctx, wp.cancel = context.WithCancel(context.Background())

	for i := 0; i < wp.workerCount; i++ {
		wp.wg.Add(1)
		go wp.worker(fmt.Sprintf("%s-worker-%d", wp.workerID, i))
	}
}

// Stop halts the worker pool gracefully
func (wp *WorkerPool) Stop() {
	wp.logger.Info("stopping worker pool")

	// Cancel the context to signal all workers
	if wp.cancel != nil {
		wp.cancel()
	}
	close(wp.stopCh)

	// Wait for all workers to finish first
	wp.wg.Wait()

	// Now safely drain any remaining jobs in the queue
	drainCount := 0
	for {
		select {
		case job := <-wp.queue:
			wp.returnJobToPending(job)
			drainCount++
		default:
			wp.logger.Info("worker pool stopped", "jobs_drained", drainCount)
			return
		}
	}
}

// Submit adds a job to the worker pool queue
func (wp *WorkerPool) Submit(job *Job) error {
	select {
	case wp.queue <- job:
		return nil
	case <-wp.stopCh:
		return fmt.Errorf("worker pool is stopped")
	default:
		return fmt.Errorf("worker pool queue is full")
	}
}

// CanAccept returns true if the pool can accept more jobs
func (wp *WorkerPool) CanAccept() bool {
	return len(wp.queue) < cap(wp.queue)
}

// GetStats returns statistics about the worker pool
func (wp *WorkerPool) GetStats() WorkerStats {
	wp.mu.RLock()
	defer wp.mu.RUnlock()

	return WorkerStats{
		WorkerID:      wp.workerID,
		JobType:       wp.jobType,
		ActiveJobs:    len(wp.activeJobs),
		ProcessedJobs: wp.processedCount,
		FailedJobs:    wp.failedCount,
		StartedAt:     wp.startedAt,
	}
}

// worker is the main worker loop
func (wp *WorkerPool) worker(id string) {
	defer wp.wg.Done()
	defer func() {
		if r := recover(); r != nil {
			wp.logger.Error("worker panic recovered", "worker_id", id, "panic", r)
		}
	}()

	logger := wp.logger.With("worker_id", id)
	logger.Info("worker started")

	for {
		select {
		case <-wp.stopCh:
			logger.Info("worker stopping")
			return
		case <-wp.ctx.Done():
			logger.Info("worker stopping (context cancelled)")
			return
		case job, ok := <-wp.queue:
			if !ok {
				logger.Info("worker stopping (queue closed)")
				return
			}
			wp.processJob(job, id)
		}
	}
}

// processJob processes a single job
func (wp *WorkerPool) processJob(job *Job, workerID string) {
	logger := wp.logger.With(
		"job_id", job.ID,
		"domain", job.Domain,
		"worker", workerID,
		"attempt", job.RetryCount+1,
	)

	// Use pool context for cancellation support
	ctx := wp.ctx
	if ctx == nil {
		ctx = context.Background()
	}

	// Mark job as running
	if err := MarkJobRunning(ctx, wp.db, job.ID, workerID); err != nil {
		logger.Error("failed to mark job running", "error", err)
		wp.handleJobError(job, fmt.Errorf("mark running: %w", err), 0)
		return
	}

	// Track active job and start time
	startTime := time.Now()
	wp.mu.Lock()
	wp.activeJobs[job.ID] = job
	wp.activeStartTime[job.ID] = startTime
	wp.mu.Unlock()

	defer func() {
		wp.mu.Lock()
		delete(wp.activeJobs, job.ID)
		delete(wp.activeStartTime, job.ID)
		wp.mu.Unlock()
	}()

	// Remove from in-flight tracking when done (success, failure, or panic)
	defer func() {
		if wp.onJobComplete != nil {
			wp.onJobComplete(job.ID)
		}
	}()

	// Panic recovery with retry counting - this MUST be the last defer to catch panics
	defer func() {
		if r := recover(); r != nil {
			panicMsg := fmt.Sprintf("Job handler panic: %v", r)
			logger.Error("job handler panic recovered", "panic", r, "panic_count", job.PanicCount+1)
			job.AddLog("ERROR", panicMsg)

			// Increment panic count and check if we should fail permanently
			panicCount, markedFailed, err := IncrementJobPanicCount(ctx, wp.db, job.ID, panicMsg, job.Logs)
			if err != nil {
				logger.Error("failed to increment panic count", "error", err)
			}

			if markedFailed {
				logger.Error("job failed permanently due to excessive panics",
					"job_id", job.ID,
					"panic_count", panicCount,
					"max_panic_retries", MaxPanicRetries)
				wp.mu.Lock()
				wp.failedCount++
				wp.mu.Unlock()

				// Trigger webhook on permanent failure due to panics
				if wp.webhookService != nil {
					duration := time.Since(startTime)
					wp.webhookService.TriggerWebhook(job.WebhookURL, job, duration)
				}
			} else {
				logger.Warn("job will be retried after panic",
					"job_id", job.ID,
					"panic_count", panicCount,
					"max_panic_retries", MaxPanicRetries)
			}
		}
	}()

	job.WorkerID = workerID
	job.AddLog("INFO", fmt.Sprintf("Job started by worker %s (attempt %d/%d)", workerID, job.RetryCount+1, job.MaxRetries))

	logger.Info("processing job")

	// Process the job with timeout
	processCtx, cancel := context.WithTimeout(ctx, DefaultJobTimeout)
	defer cancel()

	err := wp.handler.Process(processCtx, job, wp.db)

	// Calculate duration for webhook
	duration := time.Since(startTime)

	if err != nil {
		logger.Error("job failed", "error", err)
		job.AddLog("ERROR", fmt.Sprintf("Job failed: %v", err))
		wp.handleJobError(job, err, duration)
	} else {
		logger.Info("job succeeded")
		job.AddLog("INFO", "Job completed successfully")
		wp.handleJobSuccess(job, duration)
	}
}

// handleJobSuccess handles a successful job completion
func (wp *WorkerPool) handleJobSuccess(job *Job, duration time.Duration) {
	ctx := wp.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	if err := MarkJobFinished(ctx, wp.db, job.ID, true, "", job.Logs); err != nil {
		wp.logger.Error("failed to mark job finished", "job_id", job.ID, "error", err)
	}

	wp.mu.Lock()
	wp.processedCount++
	wp.mu.Unlock()

	// Trigger webhook on success
	if wp.webhookService != nil {
		wp.webhookService.TriggerWebhook(job.WebhookURL, job, duration)
	}
}

// handleJobError handles a job failure and potentially retries
func (wp *WorkerPool) handleJobError(job *Job, jobErr error, duration time.Duration) {
	ctx := wp.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	job.RetryCount++

	// Smart error truncation: keep the end of the message (usually most informative)
	errMsg := jobErr.Error()
	if len(errMsg) > MaxErrorLength {
		errMsg = "..." + errMsg[len(errMsg)-(MaxErrorLength-3):]
	}

	// Check if we should retry
	if job.CanRetry() {
		nextRetry := CalculateNextRetry(job.CreatedAt, job.RetryCount, wp.retryConfig)
		delay := time.Until(nextRetry)

		job.AddLog("WARN", fmt.Sprintf("Job failed, scheduling retry %d/%d in %s",
			job.RetryCount, job.MaxRetries, FormatRetryDelay(delay)))

		if err := MarkJobForRetry(ctx, wp.db, job.ID, job.RetryCount, nextRetry, errMsg, job.Logs); err != nil {
			wp.logger.Error("failed to mark job for retry", "job_id", job.ID, "error", err)
		}

		wp.logger.Info("job scheduled for retry",
			"job_id", job.ID,
			"retry_count", job.RetryCount,
			"max_retries", job.MaxRetries,
			"next_retry", nextRetry)
	} else {
		// No more retries - job failed permanently
		job.AddLog("ERROR", fmt.Sprintf("Job failed permanently after %d attempts: %s", job.RetryCount, errMsg))

		if err := MarkJobFinished(ctx, wp.db, job.ID, false, errMsg, job.Logs); err != nil {
			wp.logger.Error("failed to mark job failed", "job_id", job.ID, "error", err)
		}

		wp.mu.Lock()
		wp.failedCount++
		wp.mu.Unlock()

		// Trigger webhook on permanent failure
		if wp.webhookService != nil {
			wp.webhookService.TriggerWebhook(job.WebhookURL, job, duration)
		}
	}
}

// returnJobToPending returns a job to pending status (for graceful shutdown)
func (wp *WorkerPool) returnJobToPending(job *Job) {
	ctx := wp.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	if err := UpdateJobStatus(ctx, wp.db, job.ID, JobStatusPending, "Job interrupted by shutdown"); err != nil {
		wp.logger.Error("failed to return job to pending", "job_id", job.ID, "error", err)
	}
}
