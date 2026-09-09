package security

import (
	"fmt"
	"time"
)

func (s *Service) notificationWorker(id int) {
	defer s.workersWg.Done()

	s.logger.Debug("Notification worker started", "workerId", id)

	for {
		select {
		case event := <-s.notificationQueue:
			s.processNotification(event)
		case <-s.stopWorkers:
			s.logger.Debug("Notification worker stopped", "workerId", id)
			return
		}
	}
}

func (s *Service) processNotification(event *Event) {
	if !s.notifier.IsConfigured() {
		return
	}

	if !s.shouldSendNotification(event) {
		return
	}

	recipients, err := s.getNotificationRecipients(event)
	if err != nil {
		s.logger.Error("Failed to get notification recipients", "error", err)
		return
	}

	if len(recipients) == 0 {
		return
	}

	subject := s.buildNotificationSubject(event)
	body := s.buildNotificationBody(event)

	if err := s.notifier.SendNotification(recipients, subject, body); err != nil {
		s.logger.Error("Failed to send notification", "error", err)
	} else {
		s.IncrementNotificationsSent()
		s.logger.Info("Security notification sent",
			"eventType", event.EventType,
			"recipients", len(recipients),
		)
	}
}

func (s *Service) getNotificationRecipients(event *Event) ([]string, error) {
	var recipients []string

	// Get admins with notifications enabled who want this kind of event
	rows, err := s.db.Query(`
		SELECT u.email, s.notifications_enabled, s.notify_on_login,
		       s.notify_on_failed_login, s.notify_on_password_change, s.notify_on_admin_action,
		       s.notify_on_app_updates, s.notify_on_user_management,
		       s.notify_on_health_alert, s.notify_on_disk_warning, s.notify_on_docker_failure,
		       s.notify_on_database_issue
		FROM users u
		JOIN user_security_settings s ON u.id = s.user_id
		WHERE u.role = 'admin'
	`)
	if err != nil {
		return nil, fmt.Errorf("query admins: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var email string
		var settings UserSettings
		if err := rows.Scan(
			&email,
			&settings.NotificationsEnabled,
			&settings.NotifyOnLogin,
			&settings.NotifyOnFailedLogin,
			&settings.NotifyOnPasswordChange,
			&settings.NotifyOnAdminAction,
			&settings.NotifyOnAppUpdates,
			&settings.NotifyOnUserManagement,
			&settings.NotifyOnHealthAlert,
			&settings.NotifyOnDiskWarning,
			&settings.NotifyOnDockerFailure,
			&settings.NotifyOnDatabaseIssue,
		); err != nil {
			s.logger.Error("Failed to scan admin notification settings", "error", err)
			continue
		}
		if event.ShouldNotify(&settings) {
			recipients = append(recipients, email)
		}
	}

	// Also notify the affected user if applicable
	if event.ActorID != "" {
		var userEmail string
		err := s.db.QueryRow(`
			SELECT u.email 
			FROM users u
			JOIN user_security_settings s ON u.id = s.user_id
			WHERE u.id = ? AND s.notifications_enabled = true
		`, event.ActorID).Scan(&userEmail)
		if err == nil {
			recipients = append(recipients, userEmail)
		}
	}

	return recipients, nil
}

func (s *Service) buildNotificationSubject(event *Event) string {
	return "Security Alert: " + getEventTitle(event)
}

func (s *Service) buildNotificationBody(event *Event) string {
	// The friendly builder in notifier.go already handles every event in
	// plain language (no raw event codes, anonymized IPs, human timestamps,
	// and a UI path to act on). Use it for the queue path too.
	return buildSecurityEmail(event)
}

func (s *Service) shouldNotify(event *Event) bool {
	// Gate which events enter the notification pipeline at all. Critical
	// security events are always notified; everything else is sent to
	// recipients whose preferences opt them in (getNotificationRecipients
	// filters per-event via ShouldNotify).
	switch event.EventType {
	case EventAccountLocked, EventSuspiciousActivity, EventBruteForceDetected,
		EventTokenReuse, EventTokenRevoked,
		EventLoginSuccess, EventLoginFailed, EventPasswordChanged, EventPasswordReset,
		EventAdminAction, EventSettingsChanged, EventConfigChanged,
		EventAppInstalled, EventAppUpdated, EventAppRemoved,
		EventUserCreated, EventUserDeleted:
		return true
	default:
		return false
	}
}

func (s *Service) shouldSendNotification(event *Event) bool {
	s.notificationMu.Lock()
	defer s.notificationMu.Unlock()

	key := fmt.Sprintf("%s:%s", event.EventType, event.IPAddress)
	lastTime, exists := s.lastNotificationTimes[key]

	if !exists || time.Since(lastTime) > s.config.NotificationThrottle {
		s.lastNotificationTimes[key] = time.Now()
		return true
	}

	return false
}
