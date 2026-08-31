package jobqueue

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type testJobHandler struct {
	jobType JobType
	err     error
	panicV  any
}

func (h *testJobHandler) Type() JobType { return h.jobType }

func (h *testJobHandler) Process(context.Context, *Job, *database.DB) error {
	if h.panicV != nil {
		panic(h.panicV)
	}
	return h.err
}

func (h *testJobHandler) MaxRetries() int { return 3 }

func openJobDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.Open(":memory:")
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
		t.Fatalf("create job: %v", err)
	}
	return job
}

func TestValidateJobInput(t *testing.T) {
	longDomain := strings.Repeat("a", 254)
	longEmail := strings.Repeat("a", 250) + "@x.com"
	tests := []struct {
		name     string
		jobType  JobType
		domain   string
		email    string
		priority JobPriority
		want     string
	}{
		{"valid", JobTypeIssuance, "example.com", "a@example.com", PriorityNormal, ""},
		{"missing type", "", "example.com", "a@example.com", PriorityNormal, "job type is required"},
		{"invalid type", "other", "example.com", "a@example.com", PriorityNormal, "invalid job type"},
		{"missing domain", JobTypeIssuance, "", "a@example.com", PriorityNormal, "domain is required"},
		{"long domain", JobTypeIssuance, longDomain, "a@example.com", PriorityNormal, "domain exceeds"},
		{"missing email", JobTypeIssuance, "example.com", "", PriorityNormal, "email is required"},
		{"long email", JobTypeIssuance, "example.com", longEmail, PriorityNormal, "email exceeds"},
		{"malformed email", JobTypeIssuance, "example.com", "invalid", PriorityNormal, "missing @"},
		{"low priority", JobTypeIssuance, "example.com", "a@example.com", 0, "invalid priority"},
		{"high priority", JobTypeIssuance, "example.com", "a@example.com", 10, "invalid priority"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateJobInput(tt.jobType, tt.domain, tt.email, tt.priority)
			if tt.want == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)) {
				t.Fatalf("error = %v, want substring %q", err, tt.want)
			}
		})
	}
}

func TestJobDatabaseLifecycleAndQueries(t *testing.T) {
	db := openJobDB(t)
	ctx := context.Background()

	job := createTestJob(t, db, "lifecycle.example.com")
	if job.RouteID != "route-1" || job.Status != JobStatusQueued {
		t.Fatalf("unexpected created job: %+v", job)
	}
	if _, err := CreateJob(ctx, db, JobTypeIssuance, job.Domain, job.Email, "", PriorityNormal); err == nil {
		t.Fatal("expected duplicate job rejection")
	}
	if pending, err := HasPendingOrQueuedJob(ctx, db, job.Domain, job.Type); err != nil || !pending {
		t.Fatalf("pending check = %v, %v", pending, err)
	}

	gotInfo, err := GetJobByID(ctx, db, job.ID)
	if err != nil {
		t.Fatalf("get job: %v", err)
	}
	got := gotInfo.(*Job)
	if got.GetID() != job.ID || got.GetDomain() != job.Domain || got.GetType() != string(job.Type) ||
		got.GetPriority() != int(job.Priority) || got.GetRetryCount() != 0 || got.GetMaxRetries() != 3 {
		t.Fatalf("job accessors returned unexpected values: %+v", got)
	}
	if _, err := GetJobByID(ctx, db, "missing"); err == nil {
		t.Fatal("expected missing job error")
	}
	for _, typ := range []JobType{"", JobTypeIssuance} {
		latest, err := GetLatestJobForDomain(ctx, db, job.Domain, typ)
		if err != nil || latest.GetID() != job.ID {
			t.Fatalf("latest (%q) = %v, %v", typ, latest, err)
		}
	}

	if err := MarkJobRunning(ctx, db, job.ID, "worker-1"); err != nil {
		t.Fatalf("mark running: %v", err)
	}
	running, err := GetRunningJobs(ctx, db)
	if err != nil || len(running) != 1 || running[0].WorkerID != "worker-1" {
		t.Fatalf("running jobs = %+v, %v", running, err)
	}
	next := time.Now().Add(-time.Minute)
	logs := []JobLogEntry{{Timestamp: time.Now(), Level: "WARN", Message: "retrying"}}
	if err := MarkJobForRetry(ctx, db, job.ID, 1, next, "temporary", logs); err != nil {
		t.Fatalf("mark retry: %v", err)
	}
	pendingJobs, err := GetPendingJobs(ctx, db, 10)
	if err != nil || len(pendingJobs) != 1 || pendingJobs[0].RetryCount != 1 {
		t.Fatalf("pending jobs = %+v, %v", pendingJobs, err)
	}

	if err := MarkJobFinished(ctx, db, job.ID, true, "", logs); err != nil {
		t.Fatalf("finish job: %v", err)
	}
	succeeded, err := GetJobsByStatus(ctx, db, JobStatusSucceeded, 10)
	if err != nil || len(succeeded) != 1 || !succeeded[0].IsTerminal() {
		t.Fatalf("succeeded jobs = %+v, %v", succeeded, err)
	}

	orphan := createTestJob(t, db, "orphan.example.com")
	if err := MarkJobRunning(ctx, db, orphan.ID, "dead-worker"); err != nil {
		t.Fatalf("mark orphan running: %v", err)
	}
	if err := ResetOrphanedRunningJobs(ctx, db); err != nil {
		t.Fatalf("reset orphans: %v", err)
	}
	failed, err := GetJobsByStatus(ctx, db, JobStatusFailed, 10)
	if err != nil || len(failed) != 1 || !strings.Contains(failed[0].Error, "orphaned") {
		t.Fatalf("failed jobs = %+v, %v", failed, err)
	}

	stats, err := GetQueueStats(ctx, db)
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if stats.Succeeded != 1 || stats.Failed != 1 || stats.Total != 0 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}

func TestQueueRegistrationEnqueueCancelAndTracking(t *testing.T) {
	db := openJobDB(t)
	q := NewQueue(QueueConfig{DB: db})
	if q.IsRunning() {
		t.Fatal("new queue should not be running")
	}
	if err := q.RegisterHandler(nil, HandlerConfig{}); err == nil {
		t.Fatal("expected nil handler error")
	}
	if err := q.RegisterHandler(&testJobHandler{}, HandlerConfig{}); err == nil {
		t.Fatal("expected empty type error")
	}
	handler := &testJobHandler{jobType: JobTypeIssuance}
	if err := q.RegisterHandler(handler, HandlerConfig{WorkerCount: 101}); err == nil {
		t.Fatal("expected worker limit error")
	}
	if err := q.RegisterHandler(handler, HandlerConfig{QueueSize: 10001}); err == nil {
		t.Fatal("expected queue limit error")
	}
	if err := q.RegisterHandler(handler, HandlerConfig{WorkerCount: 1, QueueSize: 2}); err != nil {
		t.Fatalf("register handler: %v", err)
	}
	if err := q.RegisterHandler(handler, HandlerConfig{}); err == nil {
		t.Fatal("expected duplicate handler error")
	}
	if _, err := q.Enqueue(JobTypeRenewal, "none.example.com", "a@example.com", "", PriorityNormal); err == nil {
		t.Fatal("expected unregistered type error")
	}

	info, err := q.Enqueue(JobTypeIssuance, "cancel.example.com", "a@example.com", "", PriorityNormal)
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := q.CancelJob(info.GetID()); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if err := q.CancelJob(info.GetID()); err == nil {
		t.Fatal("expected second cancellation to fail")
	}
	if err := q.CancelJob("missing"); err == nil {
		t.Fatal("expected missing cancellation to fail")
	}

	if !q.tryAddInFlight("fresh") || q.tryAddInFlight("fresh") {
		t.Fatal("in-flight atomic add did not reject duplicate")
	}
	q.inFlight["stale"] = time.Now().Add(-3 * DefaultJobTimeout)
	if !q.tryAddInFlight("stale") {
		t.Fatal("stale in-flight entry should be replaceable")
	}
	q.inFlight["cleanup"] = time.Now().Add(-3 * DefaultJobTimeout)
	q.cleanupStaleInFlight()
	if _, ok := q.inFlight["cleanup"]; ok {
		t.Fatal("stale entry was not cleaned")
	}
	q.RemoveFromInFlight("fresh")

	if _, err := q.GetJob(context.Background(), info.GetID()); err != nil {
		t.Fatalf("queue get job: %v", err)
	}
	if _, err := q.GetLatestJob(context.Background(), "cancel.example.com", JobTypeIssuance); err != nil {
		t.Fatalf("queue latest: %v", err)
	}
	if jobs, err := q.GetJobsByStatus(JobStatusCancelled, 10); err != nil || len(jobs) != 1 {
		t.Fatalf("queue jobs by status = %+v, %v", jobs, err)
	}
	if jobs, err := q.GetPendingJobs(10); err != nil || len(jobs) != 0 {
		t.Fatalf("queue pending = %+v, %v", jobs, err)
	}
	if jobs, err := q.GetRunningJobs(); err != nil || len(jobs) != 0 {
		t.Fatalf("queue running = %+v, %v", jobs, err)
	}
	if stats, err := q.GetQueueStats(); err != nil || stats.Total != 0 {
		t.Fatalf("queue stats = %+v, %v", stats, err)
	}
	if pools, stats, err := q.GetStats(); err != nil || len(pools) != 1 || stats == nil {
		t.Fatalf("combined stats = %+v, %+v, %v", pools, stats, err)
	}
	q.Stop()
}

func TestWorkerPoolProcessesSuccessRetryFailureAndPanic(t *testing.T) {
	db := openJobDB(t)
	tests := []struct {
		name       string
		handler    *testJobHandler
		maxRetries int
		wantStatus JobStatus
	}{
		{"success", &testJobHandler{jobType: JobTypeIssuance}, 3, JobStatusSucceeded},
		{"retry", &testJobHandler{jobType: JobTypeIssuance, err: errors.New("temporary")}, 3, JobStatusPending},
		{"failure", &testJobHandler{jobType: JobTypeIssuance, err: errors.New(strings.Repeat("x", MaxErrorLength+20))}, 1, JobStatusFailed},
		{"panic", &testJobHandler{jobType: JobTypeIssuance, panicV: "boom"}, 3, JobStatusPending},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			job := createTestJob(t, db, "worker-"+string(rune('a'+i))+".example.com")
			job.MaxRetries = tt.maxRetries
			if _, err := db.Exec("UPDATE acme_jobs SET max_retries = ? WHERE id = ?", tt.maxRetries, job.ID); err != nil {
				t.Fatalf("set retries: %v", err)
			}
			completed := ""
			wp := NewWorkerPool(WorkerPoolConfig{
				JobType:       JobTypeIssuance,
				Handler:       tt.handler,
				DB:            db,
				WorkerCount:   1,
				QueueSize:     1,
				RetryConfig:   RetryConfig{InitialBackoff: time.Millisecond, MaxBackoff: time.Second, Multiplier: 1},
				OnJobComplete: func(id string) { completed = id },
			})
			wp.processJob(job, "worker-test")
			got, err := GetJobByID(context.Background(), db, job.ID)
			if err != nil {
				t.Fatalf("get processed job: %v", err)
			}
			if JobStatus(got.GetStatus()) != tt.wantStatus {
				t.Fatalf("status = %s, want %s", got.GetStatus(), tt.wantStatus)
			}
			if completed != job.ID {
				t.Fatalf("completion callback = %q", completed)
			}
			stats := wp.GetStats()
			if tt.wantStatus == JobStatusSucceeded && stats.ProcessedJobs != 1 {
				t.Fatalf("processed stats = %+v", stats)
			}
			if tt.wantStatus == JobStatusFailed && stats.FailedJobs != 1 {
				t.Fatalf("failed stats = %+v", stats)
			}
		})
	}
}

func TestQueueStartProcessesPendingJob(t *testing.T) {
	db := openJobDB(t)
	q := NewQueue(QueueConfig{DB: db})
	if err := q.RegisterHandler(&testJobHandler{jobType: JobTypeIssuance}, HandlerConfig{WorkerCount: 1, QueueSize: 2}); err != nil {
		t.Fatalf("register: %v", err)
	}
	info, err := q.Enqueue(JobTypeIssuance, "started.example.com", "a@example.com", "", PriorityNormal)
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := q.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := q.Start(); err == nil {
		t.Fatal("expected duplicate start error")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got, getErr := q.GetJob(context.Background(), info.GetID())
		if getErr == nil && got.GetStatus() == string(JobStatusSucceeded) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	got, err := q.GetJob(context.Background(), info.GetID())
	if err != nil || got.GetStatus() != string(JobStatusSucceeded) {
		t.Fatalf("processed job = %+v, %v", got, err)
	}
	q.Stop()
	if q.IsRunning() {
		t.Fatal("queue should be stopped")
	}
}
