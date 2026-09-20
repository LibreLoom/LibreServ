package setup

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
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
