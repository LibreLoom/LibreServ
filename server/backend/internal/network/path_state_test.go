package network

import (
	"context"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestPathStateStoreRoundTrip(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("NewInMemory: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	store := NewPathStateStore(db)
	ctx := context.Background()

	// Empty state → zero value, no error.
	st, err := store.Get(ctx, "mc", PathDirectV4, "tcp", 25565)
	if err != nil {
		t.Fatalf("Get empty: %v", err)
	}
	if st.ConsecutiveFailures != 0 || st.ConsecutiveSuccesses != 0 {
		t.Errorf("empty state = %+v, want zeros", st)
	}

	// Record failures — counter increments, successes reset.
	if err := store.RecordFailure(ctx, "mc", PathDirectV4, "tcp", 25565, "timeout"); err != nil {
		t.Fatalf("RecordFailure: %v", err)
	}
	if err := store.RecordFailure(ctx, "mc", PathDirectV4, "tcp", 25565, "timeout"); err != nil {
		t.Fatalf("RecordFailure: %v", err)
	}
	st, _ = store.Get(ctx, "mc", PathDirectV4, "tcp", 25565)
	if st.ConsecutiveFailures != 2 || st.ConsecutiveSuccesses != 0 {
		t.Errorf("after 2 failures = %+v, want fails=2 succ=0", st)
	}
	if st.LastFailureReason != "timeout" {
		t.Errorf("last_failure_reason = %q, want timeout", st.LastFailureReason)
	}

	// A success resets failures and increments successes.
	if err := store.RecordSuccess(ctx, "mc", PathDirectV4, "tcp", 25565); err != nil {
		t.Fatalf("RecordSuccess: %v", err)
	}
	st, _ = store.Get(ctx, "mc", PathDirectV4, "tcp", 25565)
	if st.ConsecutiveFailures != 0 || st.ConsecutiveSuccesses != 1 {
		t.Errorf("after success = %+v, want fails=0 succ=1", st)
	}

	// StateForApp aggregates all paths for the app.
	if err := store.RecordFailure(ctx, "mc", PathUPnP, "udp", 25565, "denied"); err != nil {
		t.Fatalf("RecordFailure UPnP: %v", err)
	}
	all, err := store.StateForApp(ctx, "mc")
	if err != nil {
		t.Fatalf("StateForApp: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("StateForApp len = %d, want 2 (direct_v4 + upnp)", len(all))
	}
	if st := all[PathUPnP]; st.ConsecutiveFailures != 1 {
		t.Errorf("upnp state = %+v, want 1 failure", st)
	}
}
