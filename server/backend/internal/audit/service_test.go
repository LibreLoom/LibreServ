package audit

import (
	"context"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func newTestDB(t *testing.T) *database.DB {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func TestRecordAndList(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db)
	ctx := context.Background()

	entry := Entry{
		ActorID:       "user-1",
		ActorUsername: "alice",
		Action:        "app.install",
		TargetID:      "app-1",
		TargetName:    "Nextcloud",
		Status:        "success",
		Message:       "Installed successfully",
		Metadata:      map[string]interface{}{"version": "25.0.0"},
		IPAddress:     "192.168.1.10",
	}

	svc.Record(ctx, entry)

	entries, err := svc.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}

	got := entries[0]
	if got.ActorID != entry.ActorID {
		t.Errorf("ActorID = %q, want %q", got.ActorID, entry.ActorID)
	}
	if got.Action != entry.Action {
		t.Errorf("Action = %q, want %q", got.Action, entry.Action)
	}
	if got.TargetName != entry.TargetName {
		t.Errorf("TargetName = %q, want %q", got.TargetName, entry.TargetName)
	}
	if got.Status != entry.Status {
		t.Errorf("Status = %q, want %q", got.Status, entry.Status)
	}
	if got.Message != entry.Message {
		t.Errorf("Message = %q, want %q", got.Message, entry.Message)
	}
	if got.IPAddress != entry.IPAddress {
		t.Errorf("IPAddress = %q, want %q", got.IPAddress, entry.IPAddress)
	}
	if got.Metadata["version"] != "25.0.0" {
		t.Errorf("Metadata[version] = %v, want 25.0.0", got.Metadata["version"])
	}
	if got.Timestamp.IsZero() {
		t.Error("Timestamp should not be zero")
	}
	if got.ID == 0 {
		t.Error("ID should not be 0")
	}
}

func TestList_DefaultLimit(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db)
	ctx := context.Background()

	// Insert 150 entries
	for i := 0; i < 150; i++ {
		svc.Record(ctx, Entry{
			ActorID:       "user-1",
			ActorUsername: "alice",
			Action:        "app.install",
			Status:        "success",
		})
	}

	// Default limit is 100
	entries, err := svc.List(ctx, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 100 {
		t.Errorf("expected 100 entries with default limit, got %d", len(entries))
	}
}

func TestList_CustomLimit(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db)
	ctx := context.Background()

	for i := 0; i < 20; i++ {
		svc.Record(ctx, Entry{
			ActorID:       "user-1",
			ActorUsername: "alice",
			Action:        "app.install",
			Status:        "success",
		})
	}

	entries, err := svc.List(ctx, 5)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 5 {
		t.Errorf("expected 5 entries, got %d", len(entries))
	}
}

func TestList_ReturnsNewestFirst(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db)
	ctx := context.Background()

	svc.Record(ctx, Entry{
		ActorID: "user-1",
		Action:  "first",
		Status:  "success",
	})
	svc.Record(ctx, Entry{
		ActorID: "user-1",
		Action:  "second",
		Status:  "success",
	})
	svc.Record(ctx, Entry{
		ActorID: "user-1",
		Action:  "third",
		Status:  "success",
	})

	entries, err := svc.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}

	// Newest first
	if entries[0].Action != "third" {
		t.Errorf("expected newest entry first, got action=%q", entries[0].Action)
	}
	if entries[2].Action != "first" {
		t.Errorf("expected oldest entry last, got action=%q", entries[2].Action)
	}
}

func TestList_EmptyTable(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db)
	ctx := context.Background()

	entries, err := svc.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

func TestRecord_NilMetadata(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db)
	ctx := context.Background()

	svc.Record(ctx, Entry{
		ActorID:  "user-1",
		Action:   "test",
		Status:   "success",
		Metadata: nil,
	})

	entries, err := svc.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Metadata == nil {
		t.Error("expected metadata to be initialized (not nil)")
	}
}

func TestRecord_MultipleEntries(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db)
	ctx := context.Background()

	actions := []string{"app.install", "app.stop", "app.start", "app.uninstall"}
	for _, action := range actions {
		svc.Record(ctx, Entry{
			ActorID: "user-1",
			Action:  action,
			Status:  "success",
		})
	}

	entries, err := svc.List(ctx, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != len(actions) {
		t.Errorf("expected %d entries, got %d", len(actions), len(entries))
	}
}
