package jobqueue

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type testJobHandler struct {
	jobType JobType
	err     error
}

func (h *testJobHandler) Type() JobType { return h.jobType }
func (h *testJobHandler) Process(context.Context, *Job, *database.DB) error {
	return h.err
}
func (h *testJobHandler) MaxRetries() int { return 3 }

func openJobQueueTestDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func createTestJob(t *testing.T, db *database.DB, domain string) *Job {
	t.Helper()
	job, err := CreateJob(context.Background(), db, JobTypeIssuance, domain, "owner@example.com", "route-1", PriorityNormal)
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	return job
}

func TestValidateJobInput(t *testing.T) {
	longDomain := strings.Repeat("a", 254)
	longEmail := strings.Repeat("a", 250) + "@test"
	tests := []struct {
		name     string
		jobType  JobType
		domain   string
		email    string
		priority JobPriority
		want     string
	}{
		{"missing type", "", "example.com", "a@example.com", PriorityNormal, "job type is required"},
		{"invalid type", "other", "example.com", "a@example.com", PriorityNormal, "invalid job type"},
		{"missing domain", JobTypeIssuance, "", "a@example.com", PriorityNormal, "domain is required"},
		{"long domain", JobTypeIssuance, longDomain, "a@example.com", PriorityNormal, "domain exceeds"},
		{"missing email", JobTypeIssuance, "example.com", "", PriorityNormal, "email is required"},
		{"long email", JobTypeIssuance, "example.com", longEmail, PriorityNormal, "email exceeds"},
		{"invalid email", JobTypeIssuance, "example.com", "invalid", PriorityNormal, "missing @"},
		{"low priority", JobTypeIssuance, "example.com", "a@example.com", 0, "invalid priority"},
		{"high priority", JobTypeIssuance, "example.com", "a@example.com", 10, "invalid priority"},
		{"valid", JobTypeValidation, "example.com", "a@example.com", PriorityCritical, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateJobInput(tt.jobType, tt.domain, tt.email, tt.priority)
			if tt.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want substring %q", err, tt.want)
			}
		})
	}
}

func TestJobMethodsAndLogs(t *testing.T) {
	job := &Job{
		ID:         "id-1",
		Type:       JobTypeRenewal,
		Domain:     "example.com",
		Status:     JobStatusPending,
		Priority:   PriorityLow,
		RetryCount: 1,
		MaxRetries: 2,
	}
	if job.GetID() != "id-1" || job.GetStatus() != "pending" || job.GetDomain() != "example.com" ||
		job.GetType() != "renewal" || job.GetPriority() != int(PriorityLow) ||
		job.GetRetryCount() != 1 || job.GetMaxRetries() != 2 {
		t.Fatalf("unexpected JobInfo values: %+v", job)
	}
	if job.IsTerminal() || !job.CanRetry() {
		t.Fatal("pending job should be retryable and non-terminal")
	}
	job.Status = JobStatusSucceeded
	if !job.IsTerminal() || job.CanRetry() {
		t.Fatal("succeeded job should be terminal and not retryable")
	}
	job.Status = JobStatusFailed
	if !job.CanRetry() {
		t.Fatal("failed job with retries remaining should be retryable")
	}
	job.RetryCount = job.MaxRetries
	if job.CanRetry() {
		t.Fatal("job at max retries should not be retryable")
	}

	job.Logs = nil
	if got, err := job.LogToJSON(); err != nil || got != "[]" {
		t.Fatalf("empty LogToJSON = %q, %v", got, err)
	}
	job.AddLog("INFO", strings.Repeat("x", MaxLogMessageSize+50))
	if len(job.Logs) != 1 || len(job.Logs[0].Message) != MaxLogMessageSize ||
		!strings.HasSuffix(job.Logs[0].Message, TruncateSuffix) {
		t.Fatalf("message was not truncated correctly: length=%d", len(job.Logs[0].Message))
	}
	for i := 0; i < MaxJobLogs+5; i++ {
		job.AddLog("DEBUG", "entry")
	}
	if len(job.Logs) > MaxJobLogs {
		t.Fatalf("log count %d exceeds %d", len(job.Logs), MaxJobLogs)
	}
	encoded, err := job.LogToJSON()
	if err != nil {
		t.Fatalf("LogToJSON: %v", err)
	}
	var restored Job
	if err := restored.LoadLogsFromJSON(encoded); err != nil {
		t.Fatalf("LoadLogsFromJSON: %v", err)
	}
	if len(restored.Logs) != len(job.Logs) {
		t.Fatalf("restored %d logs, want %d", len(restored.Logs), len(job.Logs))
	}
	if err := restored.LoadLogsFromJSON("not-json"); err == nil {
		t.Fatal("expected invalid JSON error")
	}
	if err := restored.LoadLogsFromJSON("[]"); err != nil || restored.Logs != nil {
		t.Fatalf("empty logs were not reset: %+v, %v", restored.Logs, err)
	}

	wantRetries := map[JobType]int{
		JobTypeIssuance: 3, JobTypeRenewal: 5, JobTypeRevocation: 2,
		JobTypeValidation: 3, JobType("unknown"): 3,
	}
	for typ, want := range wantRetries {
		if got := DefaultMaxRetries(typ); got != want {
			t.Errorf("DefaultMaxRetries(%q) = %d, want %d", typ, got, want)
		}
	}
}

func TestDatabaseJobLifecycleAndQueries(t *testing.T) {
	ctx := context.Background()
	db := openJobQueueTestDB(t)
	job := createTestJob(t, db, "one.example.com")

	if _, err := CreateJob(ctx, db, job.Type, job.Domain, job.Email, "", job.Priority); err == nil {
		t.Fatal("expected duplicate active job to be rejected")
	}
	has, err := HasPendingOrQueuedJob(ctx, db, job.Domain, job.Type)
	if err != nil || !has {
		t.Fatalf("HasPendingOrQueuedJob = %v, %v", has, err)
	}
	info, err := GetJobByID(ctx, db, job.ID)
	if err != nil || info.GetID() != job.ID {
		t.Fatalf("GetJobByID = %+v, %v", info, err)
	}
	if _, err := GetJobByID(ctx, db, "missing"); err == nil {
		t.Fatal("expected missing job error")
	}
	for _, typ := range []JobType{"", JobTypeIssuance} {
		latest, err := GetLatestJobForDomain(ctx, db, job.Domain, typ)
		if err != nil || latest.GetID() != job.ID {
			t.Fatalf("GetLatestJobForDomain(%q) = %+v, %v", typ, latest, err)
		}
	}

	if err := MarkJobRunning(ctx, db, job.ID, "worker-1"); err != nil {
		t.Fatalf("MarkJobRunning: %v", err)
	}
	running, err := GetRunningJobs(ctx, db)
	if err != nil || len(running) != 1 || running[0].WorkerID != "worker-1" || running[0].StartedAt == nil {
		t.Fatalf("GetRunningJobs = %+v, %v", running, err)
	}
	nextRetry := time.Now().Add(-time.Minute)
	logs := []JobLogEntry{{Timestamp: time.Now(), Level: "WARN", Message: "retry"}}
	if err := MarkJobForRetry(ctx, db, job.ID, 1, nextRetry, "temporary", logs); err != nil {
		t.Fatalf("MarkJobForRetry: %v", err)
	}
	pending, err := GetPendingJobs(ctx, db, 10)
	if err != nil || len(pending) != 1 || pending[0].RetryCount != 1 || pending[0].NextRetryAt == nil {
		t.Fatalf("GetPendingJobs = %+v, %v", pending, err)
	}
	if err := MarkJobFinished(ctx, db, job.ID, true, "", logs); err != nil {
		t.Fatalf("MarkJobFinished: %v", err)
	}
	succeeded, err := GetJobsByStatus(ctx, db, JobStatusSucceeded, 10)
	if err != nil || len(succeeded) != 1 || succeeded[0].EndedAt == nil || succeeded[0].WorkerID != "" {
		t.Fatalf("succeeded jobs = %+v, %v", succeeded, err)
	}

	runningJob := createTestJob(t, db, "orphan.example.com")
	if err := MarkJobRunning(ctx, db, runningJob.ID, "dead-worker"); err != nil {
		t.Fatalf("mark orphan running: %v", err)
	}
	if err := ResetOrphanedRunningJobs(ctx, db); err != nil {
		t.Fatalf("ResetOrphanedRunningJobs: %v", err)
	}
	orphan, err := GetJobByID(ctx, db, runningJob.ID)
	if err != nil || orphan.GetStatus() != string(JobStatusFailed) {
		t.Fatalf("orphan = %+v, %v", orphan, err)
	}

	stats, err := GetQueueStats(ctx, db)
	if err != nil {
		t.Fatalf("GetQueueStats: %v", err)
	}
	if stats.Succeeded != 1 || stats.Failed != 1 || stats.Total != 0 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
	if err := UpdateJobStatus(ctx, db, runningJob.ID, JobStatusCancelled, "cancelled"); err != nil {
		t.Fatalf("UpdateJobStatus: %v", err)
	}
}

func TestQueueRegistrationEnqueueCancelAndInflight(t *testing.T) {
	db := openJobQueueTestDB(t)
	q := NewQueue(QueueConfig{DB: db})
	if q.retryConfig.InitialBackoff == 0 {
		t.Fatal("default retry config was not applied")
	}
	if err := q.RegisterHandler(nil, HandlerConfig{}); err == nil {
		t.Fatal("expected nil handler error")
	}
	if err := q.RegisterHandler(&testJobHandler{}, HandlerConfig{}); err == nil {
		t.Fatal("expected empty job type error")
	}
	handler := &testJobHandler{jobType: JobTypeIssuance}
	if err := q.RegisterHandler(handler, HandlerConfig{WorkerCount: 101}); err == nil {
		t.Fatal("expected worker limit error")
	}
	if err := q.RegisterHandler(handler, HandlerConfig{QueueSize: 10001}); err == nil {
		t.Fatal("expected queue limit error")
	}
	if err := q.RegisterHandler(handler, HandlerConfig{WorkerCount: 1, QueueSize: 2}); err != nil {
		t.Fatalf("RegisterHandler: %v", err)
	}
	if err := q.RegisterHandler(handler, HandlerConfig{}); err == nil {
		t.Fatal("expected duplicate handler error")
	}
	if _, err := q.Enqueue(JobTypeRenewal, "none.example.com", "a@example.com", "", PriorityNormal); err == nil {
		t.Fatal("expected unregistered type error")
	}
	info, err := q.Enqueue(JobTypeIssuance, "queued.example.com", "a@example.com", "", PriorityNormal)
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if _, err := q.GetJob(context.Background(), info.GetID()); err != nil {
		t.Fatalf("Queue.GetJob: %v", err)
	}
	if _, err := q.GetLatestJob(context.Background(), "queued.example.com", JobTypeIssuance); err != nil {
		t.Fatalf("Queue.GetLatestJob: %v", err)
	}
	if err := q.CancelJob(info.GetID()); err != nil {
		t.Fatalf("CancelJob: %v", err)
	}
	if err := q.CancelJob(info.GetID()); err == nil || !strings.Contains(err.Error(), "cannot cancel") {
		t.Fatalf("second CancelJob error = %v", err)
	}
	if err := q.CancelJob("missing"); err == nil {
		t.Fatal("expected missing cancellation error")
	}

	if !q.tryAddInFlight("job-1") || q.tryAddInFlight("job-1") {
		t.Fatal("in-flight atomic add did not reject a duplicate")
	}
	q.inFlight["stale"] = time.Now().Add(-3 * DefaultJobTimeout)
	if !q.tryAddInFlight("stale") {
		t.Fatal("stale in-flight entry should be replaceable")
	}
	q.inFlight["old"] = time.Now().Add(-3 * DefaultJobTimeout)
	q.cleanupStaleInFlight()
	if _, ok := q.inFlight["old"]; ok {
		t.Fatal("cleanup did not remove stale entry")
	}
	q.RemoveFromInFlight("job-1")

	if q.IsRunning() {
		t.Fatal("new queue should not be running")
	}
	if _, _, err := q.GetStats(); err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if _, err := q.GetJobsByStatus(JobStatusCancelled, 10); err != nil {
		t.Fatalf("GetJobsByStatus: %v", err)
	}
	if _, err := q.GetPendingJobs(10); err != nil {
		t.Fatalf("GetPendingJobs: %v", err)
	}
	if _, err := q.GetRunningJobs(); err != nil {
		t.Fatalf("GetRunningJobs: %v", err)
	}
	if _, err := q.GetQueueStats(); err != nil {
		t.Fatalf("GetQueueStats: %v", err)
	}
	q.Stop()
}

func TestQueueStartProcessesJobsAndRecoversOrphans(t *testing.T) {
	db := openJobQueueTestDB(t)
	orphan := createTestJob(t, db, "old.example.com")
	if err := MarkJobRunning(context.Background(), db, orphan.ID, "old-worker"); err != nil {
		t.Fatalf("MarkJobRunning: %v", err)
	}

	q := NewQueue(QueueConfig{DB: db, RetryConfig: RetryConfig{
		InitialBackoff: time.Millisecond, MaxBackoff: time.Millisecond, Multiplier: 1,
	}})
	if err := q.RegisterHandler(&testJobHandler{jobType: JobTypeIssuance}, HandlerConfig{WorkerCount: 1, QueueSize: 4}); err != nil {
		t.Fatalf("RegisterHandler: %v", err)
	}
	if err := q.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer q.Stop()
	if err := q.Start(); err == nil {
		t.Fatal("expected duplicate Start error")
	}
	if !q.IsRunning() {
		t.Fatal("started queue should report running")
	}
	job, err := q.Enqueue(JobTypeIssuance, "new.example.com", "a@example.com", "", PriorityNormal)
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got, getErr := q.GetJob(context.Background(), job.GetID())
		if getErr == nil && got.GetStatus() == string(JobStatusSucceeded) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	got, _ := q.GetJob(context.Background(), job.GetID())
	t.Fatalf("job was not processed: %+v", got)
}

func TestPollPendingJobWithoutPoolMarksFailure(t *testing.T) {
	db := openJobQueueTestDB(t)
	job := createTestJob(t, db, "unhandled.example.com")
	q := NewQueue(QueueConfig{DB: db})
	q.pollPendingJobs()
	got, err := GetJobByID(context.Background(), db, job.ID)
	if err != nil {
		t.Fatalf("GetJobByID: %v", err)
	}
	if got.GetStatus() != string(JobStatusFailed) {
		t.Fatalf("status = %s, want failed", got.GetStatus())
	}
}

func TestWorkerPoolSuccessRetryFailureAndCapacity(t *testing.T) {
	db := openJobQueueTestDB(t)
	successJob := createTestJob(t, db, "success.example.com")
	completed := ""
	wp := NewWorkerPool(WorkerPoolConfig{
		JobType: JobTypeIssuance, Handler: &testJobHandler{jobType: JobTypeIssuance},
		DB: db, WorkerCount: 1, QueueSize: 1, OnJobComplete: func(id string) { completed = id },
	})
	wp.processJob(successJob, "worker")
	got, err := GetJobByID(context.Background(), db, successJob.ID)
	if err != nil || got.GetStatus() != string(JobStatusSucceeded) || completed != successJob.ID {
		t.Fatalf("successful job = %+v, completed=%q, err=%v", got, completed, err)
	}
	if stats := wp.GetStats(); stats.ProcessedJobs != 1 || stats.JobType != JobTypeIssuance {
		t.Fatalf("unexpected worker stats: %+v", stats)
	}

	retryJob := createTestJob(t, db, "retry.example.com")
	wp.handler = &testJobHandler{jobType: JobTypeIssuance, err: errors.New("temporary")}
	wp.retryConfig = RetryConfig{InitialBackoff: time.Millisecond, MaxBackoff: time.Millisecond, Multiplier: 1}
	wp.processJob(retryJob, "worker")
	retried, _ := GetJobByID(context.Background(), db, retryJob.ID)
	if retried.GetStatus() != string(JobStatusPending) || retried.GetRetryCount() != 1 {
		t.Fatalf("retry job = %+v", retried)
	}

	failedJob := createTestJob(t, db, "failed.example.com")
	failedJob.MaxRetries = 0
	wp.processJob(failedJob, "worker")
	failed, _ := GetJobByID(context.Background(), db, failedJob.ID)
	if failed.GetStatus() != string(JobStatusFailed) {
		t.Fatalf("failed job = %+v", failed)
	}
	if stats := wp.GetStats(); stats.FailedJobs != 1 {
		t.Fatalf("failed count = %d, want 1", stats.FailedJobs)
	}

	queuedJob := createTestJob(t, db, "capacity.example.com")
	capacityPool := NewWorkerPool(WorkerPoolConfig{
		JobType: JobTypeIssuance, Handler: &testJobHandler{jobType: JobTypeIssuance},
		DB: db, WorkerCount: 1, QueueSize: 1,
	})
	if !capacityPool.CanAccept() {
		t.Fatal("empty pool should accept work")
	}
	if err := capacityPool.Submit(queuedJob); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if capacityPool.CanAccept() {
		t.Fatal("full pool should not accept work")
	}
	if err := capacityPool.Submit(queuedJob); err == nil {
		t.Fatal("expected full queue error")
	}
	capacityPool.Stop()
	// After Stop the queue is drained; Submit may race between the closed
	// stopCh and a free queue slot, so only assert the drained job is pending.
	_ = capacityPool.Submit(queuedJob)
	pending, _ := GetJobByID(context.Background(), db, queuedJob.ID)
	if pending.GetStatus() != string(JobStatusPending) {
		t.Fatalf("drained job status = %s, want pending", pending.GetStatus())
	}
}
