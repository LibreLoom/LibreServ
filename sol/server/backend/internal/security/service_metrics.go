package security

func (s *Service) GetMetrics() Metrics {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return Metrics{
		EventsRecorded:       s.metrics.EventsRecorded,
		NotificationsSent:    s.metrics.NotificationsSent,
		NotificationsDropped: s.metrics.NotificationsDropped,
		FailedLoginsTracked:  s.metrics.FailedLoginsTracked,
		AccountsLocked:       s.metrics.AccountsLocked,
		QueueDepth:           int32(len(s.notificationQueue)),
	}
}

func (s *Service) GetHealth() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return map[string]interface{}{
		"status":                  "healthy",
		"queue_depth":             len(s.notificationQueue),
		"queue_capacity":          cap(s.notificationQueue),
		"workers":                 s.workerCount,
		"notification_configured": s.notifier.IsConfigured(),
		"events_recorded":         s.metrics.EventsRecorded,
		"notifications_sent":      s.metrics.NotificationsSent,
		"accounts_locked":         s.metrics.AccountsLocked,
	}
}

func (s *Service) IncrementEventsRecorded() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metrics.EventsRecorded++
}

func (s *Service) IncrementNotificationsSent() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metrics.NotificationsSent++
}

func (s *Service) IncrementNotificationsDropped() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metrics.NotificationsDropped++
}

func (s *Service) IncrementFailedLoginsTracked() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metrics.FailedLoginsTracked++
}

func (s *Service) IncrementAccountsLocked() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metrics.AccountsLocked++
}
