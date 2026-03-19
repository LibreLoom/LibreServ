package jobs

import (
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/notify"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

func TestNewScheduler(t *testing.T) {
	checker := system.NewUpdateChecker("owner", "repo")
	notifySvc := notify.NewService(nil, nil)
	s := NewScheduler(nil, checker, notifySvc, "1.0.0")

	if s == nil {
		t.Fatal("NewScheduler returned nil")
	}
	if s.currentVersion != "1.0.0" {
		t.Errorf("currentVersion = %q, want 1.0.0", s.currentVersion)
	}
	if s.stopCh == nil {
		t.Error("stopCh should not be nil")
	}
}

func TestSchedulerStartStop(t *testing.T) {
	checker := system.NewUpdateChecker("owner", "repo")
	notifySvc := notify.NewService(nil, nil)
	s := NewScheduler(nil, checker, notifySvc, "1.0.0")

	s.Start()

	// Give goroutines a moment to start
	time.Sleep(50 * time.Millisecond)

	// Stop should return without deadlock
	done := make(chan struct{})
	go func() {
		s.Stop()
		close(done)
	}()

	select {
	case <-done:
		// OK
	case <-time.After(5 * time.Second):
		t.Fatal("Stop() did not return within 5s (possible deadlock)")
	}
}

func TestSchedulerDoubleStop(t *testing.T) {
	checker := system.NewUpdateChecker("owner", "repo")
	notifySvc := notify.NewService(nil, nil)
	s := NewScheduler(nil, checker, notifySvc, "1.0.0")

	s.Start()
	time.Sleep(50 * time.Millisecond)

	// First stop
	s.Stop()

	// Second stop should not panic (close on closed channel)
	// Note: This WILL panic because close(s.stopCh) on already-closed channel.
	// This test documents the current behavior - scheduler is single-use.
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic on double Stop - scheduler is single-use")
		}
	}()
	s.Stop()
}
