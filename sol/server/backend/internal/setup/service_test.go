package setup

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/Sol/internal/database"
)

func TestSetupServiceLifecycle(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	svc := NewService(db)
	ctx := context.Background()

	state, err := svc.Ensure(ctx)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if state.Status != StatusPending {
		t.Fatalf("expected pending, got %s", state.Status)
	}

	state, err = svc.MarkInProgress(ctx)
	if err != nil {
		t.Fatalf("mark in progress: %v", err)
	}
	if state.Status != StatusInProgress || state.Nonce == "" {
		t.Fatalf("unexpected state: %+v", state)
	}

	state, err = svc.MarkComplete(ctx)
	if err != nil {
		t.Fatalf("mark complete: %v", err)
	}
	if state.Status != StatusComplete {
		t.Fatalf("expected complete, got %s", state.Status)
	}

	if !svc.IsComplete(ctx) {
		t.Fatalf("expected IsComplete true")
	}

	// Ensure returns persisted complete state
	state, err = svc.Ensure(ctx)
	if err != nil {
		t.Fatalf("ensure after complete: %v", err)
	}
	if state.Status != StatusComplete {
		t.Fatalf("expected persisted complete, got %s", state.Status)
	}
	if state.CompletedAt == nil || time.Since(*state.CompletedAt) > time.Minute {
		t.Fatalf("completed_at not set correctly")
	}
}

func TestIsCompleteInvalidationContract(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	svc := NewService(db)
	ctx := context.Background()
	if _, err := svc.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.MarkComplete(ctx); err != nil {
		t.Fatal(err)
	}
	if !svc.IsComplete(ctx) {
		t.Fatal("MarkComplete should make IsComplete true")
	}

	svc.InvalidateCompletion()
	// The database still says complete, so a re-read returns true. The point
	// is that the answer now comes from the file, not the cache.
	if !svc.IsComplete(ctx) {
		t.Fatal("IsComplete should re-read the database after invalidation")
	}

	// A restore hook must have the same effect: the file changes underneath
	// the service, so the cached answer has to be dropped.
	if _, err := svc.MarkComplete(ctx); err != nil {
		t.Fatal(err)
	}
	db.SetOnReplace(svc.InvalidateCompletion)
	replacement := filepath.Join(dir, "restored.db")
	other, err := database.Open(replacement)
	if err != nil {
		t.Fatal(err)
	}
	if err := other.Migrate(); err != nil {
		t.Fatal(err)
	}
	if err := other.Close(); err != nil {
		t.Fatal(err)
	}
	if err := db.ReplaceFile(ctx, replacement); err != nil {
		t.Fatal(err)
	}
	if svc.IsComplete(ctx) {
		t.Fatal("a restore must invalidate the completion cache")
	}
}
