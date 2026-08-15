package connect

import (
	"context"
	"errors"
	"testing"
)

func TestEntitlementCheckerRefreshClearsStatusOnError(t *testing.T) {
	fake := NewFakeClient()
	ctx := context.Background()

	// 1. Activate so we have a Connected: true status.
	status, err := fake.Activate(ctx, "testkey-abc123")
	if err != nil {
		t.Fatalf("Activate failed: %v", err)
	}
	if !status.Connected {
		t.Fatal("expected Connected: true after Activate")
	}

	// 2. Refresh with working client should preserve Connected.
	checker := NewEntitlementChecker(fake)
	checker.Refresh()
	if s := checker.Status(); !s.Connected {
		t.Fatal("expected Connected after successful Refresh")
	}

	// 3. Make Status return an error (simulates 401 after deactivation).
	fake.SetErrorStatus(errors.New("connect unreachable"))
	checker.Refresh()

	s := checker.Status()
	if s.Connected {
		t.Fatal("expected Connected: false after error Refresh")
	}

	// 4. Valid() must return false after an error refresh.
	if checker.Valid() {
		t.Fatal("Valid() should be false after error refresh")
	}
}

func TestEntitlementCheckerRefreshSucceedsAfterError(t *testing.T) {
	fake := NewFakeClient()
	ctx := context.Background()

	// Activate, then error, then restore.
	fake.Activate(ctx, "testkey-xyz789")
	checker := NewEntitlementChecker(fake)

	// Induce error.
	fake.SetErrorStatus(errors.New("temp failure"))
	checker.Refresh()
	if checker.Valid() {
		t.Fatal("Valid should be false during error")
	}

	// Restore the client and refresh again — should recover.
	fake.SetErrorStatus(nil)
	checker.Refresh()
	if !checker.Valid() {
		t.Fatal("Valid should be true after recovery")
	}
	if s := checker.Status(); !s.Connected {
		t.Fatal("expected Connected: true after recovery Refresh")
	}
}

// --- FakeClient helpers for testing ---

// SetErrorStatus makes the next Status() call return the given error.
// Pass nil to restore normal behavior.
func (f *FakeClient) SetErrorStatus(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errorStatus = err
}
