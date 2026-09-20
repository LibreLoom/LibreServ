package security

import (
	"context"
	"time"
)

// cleanupRoutine periodically purges stale security state.
// Context cancel is deferred inside runPeriodicCleanup so it always runs
// (a bare defer in the select case would only fire when this goroutine exits).
func (s *Service) cleanupRoutine() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.runPeriodicCleanup()
		case <-s.stopWorkers:
			return
		}
	}
}

func (s *Service) runPeriodicCleanup() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Cleanup old events
	if err := s.CleanupOldEvents(ctx); err != nil {
		s.logger.Error("Failed to cleanup old events", "error", err)
	}

	// Cleanup old notifications tracking
	s.notificationMu.Lock()
	now := time.Now()
	for key, lastTime := range s.lastNotificationTimes {
		if now.Sub(lastTime) > s.config.NotificationThrottle*2 {
			delete(s.lastNotificationTimes, key)
		}
	}
	s.notificationMu.Unlock()

	// Cleanup old attempt windows
	s.mu.Lock()
	windowStart := now.Add(-s.config.BruteForceWindow * 2)
	for ip, window := range s.failedAttempts {
		if window.lastAttempt.Before(windowStart) && now.After(window.lockedUntil) {
			delete(s.failedAttempts, ip)
		}
	}
	for user, window := range s.userFailedLogins {
		if window.lastAttempt.Before(windowStart) && now.After(window.lockedUntil) {
			delete(s.userFailedLogins, user)
		}
	}
	s.mu.Unlock()
}
