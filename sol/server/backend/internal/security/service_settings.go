package security

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

func (s *Service) GetUserSettings(ctx context.Context, userID string) (*UserSettings, error) {
	settings := &UserSettings{UserID: userID}

	query := `
		SELECT notifications_enabled, notification_frequency, notify_on_login,
		       notify_on_failed_login, notify_on_password_change, notify_on_admin_action,
		       notify_on_app_updates, notify_on_user_management,
		       notify_on_health_alert, notify_on_disk_warning, notify_on_docker_failure,
		       notify_on_database_issue, use_12_hour_time, updated_at
		FROM user_security_settings
		WHERE user_id = ?
	`

	row := s.db.QueryRow(query, userID)
	err := row.Scan(
		&settings.NotificationsEnabled,
		&settings.NotificationFrequency,
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
		&settings.Use12HourTime,
		&settings.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		return &UserSettings{
			UserID:                 userID,
			NotificationsEnabled:   true,
			NotificationFrequency:  string(FrequencyNormal),
			NotifyOnLogin:          true,
			NotifyOnFailedLogin:    true,
			NotifyOnPasswordChange: true,
			NotifyOnAdminAction:    true,
			NotifyOnAppUpdates:     true,
			NotifyOnUserManagement: true,
			NotifyOnHealthAlert:    true,
			NotifyOnDiskWarning:    true,
			NotifyOnDockerFailure:  true,
			NotifyOnDatabaseIssue:  true,
			Use12HourTime:          false,
			UpdatedAt:              time.Now().UTC(),
		}, nil
	}

	if err != nil {
		return nil, fmt.Errorf("get user settings: %w", err)
	}

	return settings, nil
}

func (s *Service) UpdateUserSettings(ctx context.Context, settings *UserSettings) error {
	if settings == nil {
		return fmt.Errorf("settings cannot be nil")
	}

	query := `
		INSERT INTO user_security_settings 
		(user_id, notifications_enabled, notification_frequency, notify_on_login,
		 notify_on_failed_login, notify_on_password_change, notify_on_admin_action,
		 notify_on_app_updates, notify_on_user_management,
		 notify_on_health_alert, notify_on_disk_warning, notify_on_docker_failure,
		 notify_on_database_issue, use_12_hour_time, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			notifications_enabled = EXCLUDED.notifications_enabled,
			notification_frequency = EXCLUDED.notification_frequency,
			notify_on_login = EXCLUDED.notify_on_login,
			notify_on_failed_login = EXCLUDED.notify_on_failed_login,
			notify_on_password_change = EXCLUDED.notify_on_password_change,
			notify_on_admin_action = EXCLUDED.notify_on_admin_action,
			notify_on_app_updates = EXCLUDED.notify_on_app_updates,
			notify_on_user_management = EXCLUDED.notify_on_user_management,
			notify_on_health_alert = EXCLUDED.notify_on_health_alert,
			notify_on_disk_warning = EXCLUDED.notify_on_disk_warning,
			notify_on_docker_failure = EXCLUDED.notify_on_docker_failure,
			notify_on_database_issue = EXCLUDED.notify_on_database_issue,
			use_12_hour_time = EXCLUDED.use_12_hour_time,
			updated_at = EXCLUDED.updated_at
	`

	settings.UpdatedAt = time.Now().UTC()

	_, err := s.db.Exec(query,
		settings.UserID,
		settings.NotificationsEnabled,
		settings.NotificationFrequency,
		settings.NotifyOnLogin,
		settings.NotifyOnFailedLogin,
		settings.NotifyOnPasswordChange,
		settings.NotifyOnAdminAction,
		settings.NotifyOnAppUpdates,
		settings.NotifyOnUserManagement,
		settings.NotifyOnHealthAlert,
		settings.NotifyOnDiskWarning,
		settings.NotifyOnDockerFailure,
		settings.NotifyOnDatabaseIssue,
		settings.Use12HourTime,
		settings.UpdatedAt,
	)

	if err != nil {
		return fmt.Errorf("update user settings: %w", err)
	}

	s.logger.Info("User security settings updated", "userId", settings.UserID)

	return nil
}

func (s *Service) GetStats(ctx context.Context) (*Stats, error) {
	stats := &Stats{}

	// Get total event count
	query := `SELECT COUNT(*) FROM security_events`
	if err := s.db.QueryRow(query).Scan(&stats.TotalEvents); err != nil {
		return nil, fmt.Errorf("get total events: %w", err)
	}

	// Get events by type
	typeQuery := `
		SELECT event_type, COUNT(*) 
		FROM security_events 
		WHERE timestamp > ?
		GROUP BY event_type
	`
	weekAgo := time.Now().UTC().Add(-7 * 24 * time.Hour)

	rows, err := s.db.Query(typeQuery, weekAgo)
	if err != nil {
		return nil, fmt.Errorf("get events by type: %w", err)
	}
	defer rows.Close()

	stats.EventsByType = make(map[string]int64)
	for rows.Next() {
		var eventType string
		var count int64
		if err := rows.Scan(&eventType, &count); err != nil {
			return nil, fmt.Errorf("scan event type count: %w", err)
		}
		stats.EventsByType[eventType] = count
	}

	// Extract specific event types for frontend compatibility
	if count, ok := stats.EventsByType["login_success"]; ok {
		stats.SuccessfulLogins = count
	}
	if count, ok := stats.EventsByType["login_failed"]; ok {
		stats.FailedLogins = count
	}

	// Get critical events count
	criticalQuery := `
		SELECT COUNT(*) 
		FROM security_events 
		WHERE severity = 'critical' 
		AND timestamp > ?
	`
	if err := s.db.QueryRow(criticalQuery, weekAgo).Scan(&stats.CriticalEvents); err != nil {
		return nil, fmt.Errorf("get critical events: %w", err)
	}

	// Get recent lockouts
	lockoutQuery := `
		SELECT COUNT(*) 
		FROM security_events 
		WHERE event_type = 'account_locked' 
		AND timestamp > ?
	`
	if err := s.db.QueryRow(lockoutQuery, weekAgo).Scan(&stats.RecentLockouts); err != nil {
		return nil, fmt.Errorf("get recent lockouts: %w", err)
	}

	// Get unique IPs
	ipQuery := `
		SELECT COUNT(DISTINCT ip_address) 
		FROM security_events 
		WHERE timestamp > ?
	`
	if err := s.db.QueryRow(ipQuery, weekAgo).Scan(&stats.UniqueIPs); err != nil {
		return nil, fmt.Errorf("get unique ips: %w", err)
	}

	return stats, nil
}
