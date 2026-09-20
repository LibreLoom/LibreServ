package jobqueue

import (
	"context"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// TestIncrementJobPanicCount tests the panic counting functionality
func TestIncrementJobPanicCount(t *testing.T) {
	db, err := database.Open(":memory:")
	if err != nil {
		t.Fatalf("failed to create test database: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// Create a test job
	job, err := CreateJob(ctx, db, JobTypeIssuance, "test.example.com", "test@example.com", "", PriorityNormal)
	if err != nil {
		t.Fatalf("failed to create job: %v", err)
	}

	// Test incrementing panic count - should not fail yet
	for i := 1; i < MaxPanicRetries; i++ {
		panicCount, markedFailed, err := IncrementJobPanicCount(ctx, db, job.ID, "test panic", job.Logs)
		if err != nil {
			t.Fatalf("failed to increment panic count (iteration %d): %v", i, err)
		}
		if markedFailed {
			t.Errorf("expected job not to be marked as failed on iteration %d", i)
		}
		if panicCount != i {
			t.Errorf("expected panic count to be %d, got %d", i, panicCount)
		}

		// Verify job status is still pending
		jobInfo, err := GetJobByID(ctx, db, job.ID)
		if err != nil {
			t.Fatalf("failed to get job: %v", err)
		}
		if jobInfo.GetStatus() != string(JobStatusPending) {
			t.Errorf("expected job status to be pending, got %s", jobInfo.GetStatus())
		}
	}

	// One more panic should mark it as failed
	panicCount, markedFailed, err := IncrementJobPanicCount(ctx, db, job.ID, "final panic", job.Logs)
	if err != nil {
		t.Fatalf("failed to increment panic count (final): %v", err)
	}
	if !markedFailed {
		t.Error("expected job to be marked as failed after max panics")
	}
	if panicCount != MaxPanicRetries {
		t.Errorf("expected panic count to be %d, got %d", MaxPanicRetries, panicCount)
	}

	// Verify job status is now failed
	jobInfo, err := GetJobByID(ctx, db, job.ID)
	if err != nil {
		t.Fatalf("failed to get job: %v", err)
	}
	if jobInfo.GetStatus() != string(JobStatusFailed) {
		t.Errorf("expected job status to be failed, got %s", jobInfo.GetStatus())
	}
}

// TestPanicCountPersistence verifies that panic count persists across job fetches
func TestPanicCountPersistence(t *testing.T) {
	db, err := database.Open(":memory:")
	if err != nil {
		t.Fatalf("failed to create test database: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// Create a test job
	job, err := CreateJob(ctx, db, JobTypeIssuance, "test2.example.com", "test@example.com", "", PriorityNormal)
	if err != nil {
		t.Fatalf("failed to create job: %v", err)
	}

	// Increment panic count
	_, _, err = IncrementJobPanicCount(ctx, db, job.ID, "panic 1", job.Logs)
	if err != nil {
		t.Fatalf("failed to increment panic count: %v", err)
	}

	// Fetch job and verify panic count persisted
	jobInfo, err := GetJobByID(ctx, db, job.ID)
	if err != nil {
		t.Fatalf("failed to get job: %v", err)
	}

	// Type assert to *Job to access PanicCount
	j, ok := jobInfo.(*Job)
	if !ok {
		t.Fatal("failed to cast JobInfo to *Job")
	}

	if j.PanicCount != 1 {
		t.Errorf("expected panic count to be 1, got %d", j.PanicCount)
	}
}

// TestGetPendingJobsExcludesMaxPanics verifies that jobs with max panics are excluded from pending
func TestGetPendingJobsExcludesMaxPanics(t *testing.T) {
	db, err := database.Open(":memory:")
	if err != nil {
		t.Fatalf("failed to create test database: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// Create a test job
	job, err := CreateJob(ctx, db, JobTypeIssuance, "test3.example.com", "test@example.com", "", PriorityNormal)
	if err != nil {
		t.Fatalf("failed to create job: %v", err)
	}

	// Fail it MaxPanicRetries times
	for i := 0; i < MaxPanicRetries; i++ {
		// Mark as running first
		if err := MarkJobRunning(ctx, db, job.ID, "worker-1"); err != nil {
			t.Fatalf("failed to mark job running: %v", err)
		}

		_, _, err := IncrementJobPanicCount(ctx, db, job.ID, "panic", job.Logs)
		if err != nil {
			t.Fatalf("failed to increment panic count: %v", err)
		}
	}

	// Wait a bit to ensure any timing issues are resolved
	time.Sleep(100 * time.Millisecond)

	// Get pending jobs - should not include our job
	pendingJobs, err := GetPendingJobs(ctx, db, 10)
	if err != nil {
		t.Fatalf("failed to get pending jobs: %v", err)
	}

	for _, pendingJob := range pendingJobs {
		if pendingJob.ID == job.ID {
			t.Error("expected job with max panics to be excluded from pending jobs")
		}
	}
}
