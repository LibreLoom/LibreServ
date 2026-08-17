package connect

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
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

// TestEntitlementHumanSupportFollowsServerPlan guards the "Human Support
// stays Off after connecting" bug: a stale local override ("support: disabled"
// in the config file, or persisted by a previous deactivate) must never demote
// the Connect server's plan-derived state. Support is a plan entitlement — the
// server decides it, and the local ServiceStates merge must skip it.
func TestEntitlementHumanSupportFollowsServerPlan(t *testing.T) {
	cfg := &config.Config{
		Connect: config.ConnectConfig{
			ServiceStates: map[string]string{"support": "disabled"},
		},
	}
	config.SetTestConfig(cfg)
	t.Cleanup(func() { config.SetTestConfig(nil) })

	fake := NewFakeClient()
	ctx := context.Background()

	// Connect One includes human support — the server reports it connected,
	// and the local "disabled" override must not mask that.
	if _, err := fake.Activate(ctx, "test-one-token-12345"); err != nil {
		t.Fatalf("Activate failed: %v", err)
	}
	checker := NewEntitlementChecker(fake)
	checker.Refresh()

	if got := checker.Status().Services[ServiceSupport].State; got != ServiceConnected {
		t.Fatalf("expected Human Support connected on Connect One, got %q", got)
	}

	// Connect Free has no human support — the server reports it unavailable,
	// and the local override must not change that either.
	if _, err := fake.Activate(ctx, "test-free-token-12345"); err != nil {
		t.Fatalf("Activate failed: %v", err)
	}
	checker.Refresh()

	if got := checker.Status().Services[ServiceSupport].State; got != ServiceUnavailable {
		t.Fatalf("expected Human Support unavailable on Connect Free, got %q", got)
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

// Thread-safe variant of SetErrorStatus for use inside tests that hold the mutex.
func (f *FakeClient) setErrorStatusLocked(err error) {
	f.errorStatus = err
}

// Atomically toggle error status (set on first call, clear on second).
type errorToggle struct {
	fake *FakeClient
	flag atomic.Bool
}

// newErrorToggle creates a toggle: first call makes Status() error,
// second call clears the error.
func newErrorToggle(f *FakeClient) *errorToggle {
	return &errorToggle{fake: f}
}

// Trigger sets errorStatus. Returns the toggle itself for chaining.
func (t *errorToggle) Trigger() {
	t.flag.Store(true)
	t.fake.mu.Lock()
	if t.flag.Load() {
		t.fake.errorStatus = errors.New("triggered error")
	}
	t.fake.mu.Unlock()
}
