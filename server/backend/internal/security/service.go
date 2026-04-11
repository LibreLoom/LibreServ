package security

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// Stats represents security statistics
type Stats struct {
	TotalEvents      int64            `json:"total_events"`
	SuccessfulLogins int64            `json:"successful_logins"`
	FailedLogins     int64            `json:"failed_logins"`
	CriticalEvents   int64            `json:"critical_events"`
	EventsByType     map[string]int64 `json:"events_by_type"`
	RecentLockouts   int64            `json:"recent_lockouts"`
	UniqueIPs        int64            `json:"unique_ips"`
}

type Logger interface {
	Info(msg string, args ...any)
	Error(msg string, args ...any)
	Debug(msg string, args ...any)
	Warn(msg string, args ...any)
}

type Config struct {
	BruteForceThreshold   int
	BruteForceWindow      time.Duration
	LockoutDuration       time.Duration
	NotificationThrottle  time.Duration
	RetentionDays         int
	NotificationWorkers   int
	NotificationQueueSize int
	MaxAttemptsPerWindow  int // Prevents memory exhaustion
}

func DefaultConfig() Config {
	return Config{
		BruteForceThreshold:   5,
		BruteForceWindow:      10 * time.Minute,
		LockoutDuration:       15 * time.Minute,
		NotificationThrottle:  time.Hour,
		RetentionDays:         90,
		NotificationWorkers:   5,
		NotificationQueueSize: 100,
		MaxAttemptsPerWindow:  1000,
	}
}

type attemptWindow struct {
	attempts    []time.Time
	lockedUntil time.Time
	lastAttempt time.Time
}

type Service struct {
	db     *database.DB
	logger Logger
	mu     sync.RWMutex

	notifier              Notifier
	failedAttempts        map[string]*attemptWindow
	userFailedLogins      map[string]*attemptWindow
	notificationMu        sync.Mutex
	lastNotificationTimes map[string]time.Time
	notificationQueue     chan *Event
	workerCount           int
	stopWorkers           chan struct{}
	workersWg             sync.WaitGroup
	metrics               Metrics
	config                Config
}

type Metrics struct {
	EventsRecorded       uint64
	NotificationsSent    uint64
	NotificationsDropped uint64
	FailedLoginsTracked  uint64
	AccountsLocked       uint64
	QueueDepth           int32
}

type Notifier interface {
	SendNotification(recipients []string, subject, body string) error
	IsConfigured() bool
}

func NewService(db *database.DB, logger Logger, notifier Notifier) *Service {
	return NewServiceWithConfig(db, logger, notifier, DefaultConfig())
}

func NewServiceWithConfig(db *database.DB, logger Logger, notifier Notifier, config Config) *Service {
	s := &Service{
		db:                    db,
		logger:                logger,
		notifier:              notifier,
		failedAttempts:        make(map[string]*attemptWindow),
		userFailedLogins:      make(map[string]*attemptWindow),
		lastNotificationTimes: make(map[string]time.Time),
		notificationQueue:     make(chan *Event, config.NotificationQueueSize),
		workerCount:           config.NotificationWorkers,
		stopWorkers:           make(chan struct{}),
		config:                config,
	}

	// Start notification workers
	for i := 0; i < s.workerCount; i++ {
		s.workersWg.Add(1)
		go s.notificationWorker(i)
	}

	// Start cleanup routine
	go s.cleanupRoutine()

	logger.Info("Security service initialized",
		"workers", config.NotificationWorkers,
		"queueSize", config.NotificationQueueSize,
		"retentionDays", config.RetentionDays,
	)

	return s
}

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

	// Get admins who want security notifications
	rows, err := s.db.Query(`
		SELECT u.email 
		FROM users u
		JOIN user_security_settings s ON u.id = s.user_id
		WHERE u.role = 'admin' AND s.security_alerts = true
	`)
	if err != nil {
		return nil, fmt.Errorf("query admins: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			s.logger.Error("Failed to scan admin email", "error", err)
			continue
		}
		recipients = append(recipients, email)
	}

	// Also notify the affected user if applicable
	if event.ActorID != "" {
		var userEmail string
		err := s.db.QueryRow(`
			SELECT u.email 
			FROM users u
			JOIN user_security_settings s ON u.id = s.user_id
			WHERE u.id = $1 AND s.security_alerts = true
		`, event.ActorID).Scan(&userEmail)
		if err == nil {
			recipients = append(recipients, userEmail)
		}
	}

	return recipients, nil
}

func (s *Service) buildNotificationSubject(event *Event) string {
	switch event.EventType {
	case EventLoginFailed:
		return "Security Alert: Failed Login Attempt"
	case EventAccountLocked:
		return "Security Alert: Account Locked"
	case EventSuspiciousActivity:
		return "Security Alert: Suspicious Activity Detected"
	default:
		return "Security Alert"
	}
}

func (s *Service) buildNotificationBody(event *Event) string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("Event Type: %s\n", event.EventType))
	sb.WriteString(fmt.Sprintf("Time: %s\n", event.Timestamp.Format(time.RFC3339)))

	if event.IPAddress != "" {
		sb.WriteString(fmt.Sprintf("IP Address: %s\n", event.IPAddress))
	}

	if event.UserAgent != "" {
		sb.WriteString(fmt.Sprintf("User Agent: %s\n", event.UserAgent))
	}

	if event.Details != "" {
		sb.WriteString(fmt.Sprintf("Details: %s\n", event.Details))
	}

	return sb.String()
}

func (s *Service) RecordEvent(ctx context.Context, event *Event) error {
	if event == nil {
		return fmt.Errorf("event cannot be nil")
	}

	// Validate event
	if err := event.Validate(); err != nil {
		return fmt.Errorf("invalid event: %w", err)
	}

	// Set timestamp if not provided
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now().UTC()
	}

	var metadataJSON []byte
	var err error
	if len(event.Metadata) > 0 {
		metadataJSON, err = json.Marshal(event.Metadata)
		if err != nil {
			return fmt.Errorf("marshal metadata: %w", err)
		}
	}

	query := `
		INSERT INTO security_events (timestamp, event_type, severity, actor_id, actor_username, 
		ip_address, user_agent, details, metadata, notified)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id
	`

	row := s.db.QueryRow(query,
		event.Timestamp,
		event.EventType,
		event.Severity,
		event.ActorID,
		event.ActorUsername,
		event.IPAddress,
		event.UserAgent,
		event.Details,
		metadataJSON,
		event.Notified,
	)

	if err := row.Scan(&event.ID); err != nil {
		return fmt.Errorf("insert security event: %w", err)
	}

	s.IncrementEventsRecorded()

	// Queue notification for high-priority events
	if s.shouldNotify(event) {
		select {
		case s.notificationQueue <- event:
		default:
			s.IncrementNotificationsDropped()
			s.logger.Warn("Notification queue full, dropping event",
				"eventType", event.EventType,
			)
		}
	}

	s.logger.Debug("Security event recorded",
		"eventId", event.ID,
		"eventType", event.EventType,
		"actorId", event.ActorID,
	)

	return nil
}

func (s *Service) shouldNotify(event *Event) bool {
	// Only notify on specific high-priority events
	switch event.EventType {
	case EventAccountLocked, EventSuspiciousActivity, EventBruteForceDetected:
		return true
	default:
		return false
	}
}

func (s *Service) countRecentAttempts(window *attemptWindow, since time.Time) int {
	count := 0
	for _, attempt := range window.attempts {
		if attempt.After(since) {
			count++
		}
	}
	return count
}

func (s *Service) addAttempt(window *attemptWindow, now time.Time) {
	// Remove old attempts beyond MaxAttemptsPerWindow
	if len(window.attempts) >= s.config.MaxAttemptsPerWindow {
		// Keep only the most recent attempts
		window.attempts = window.attempts[len(window.attempts)-s.config.MaxAttemptsPerWindow+1:]
	}

	window.attempts = append(window.attempts, now)
	window.lastAttempt = now
}

func (s *Service) RecordFailedLogin(username, ipAddress, userAgent, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	windowStart := now.Add(-s.config.BruteForceWindow)

	// Track by IP
	if ipAddress != "" {
		ipWindow, exists := s.failedAttempts[ipAddress]
		if !exists {
			ipWindow = &attemptWindow{}
			s.failedAttempts[ipAddress] = ipWindow
		}

		s.addAttempt(ipWindow, now)

		// Check if we should lock
		recentAttempts := s.countRecentAttempts(ipWindow, windowStart)
		if recentAttempts >= s.config.BruteForceThreshold {
			ipWindow.lockedUntil = now.Add(s.config.LockoutDuration)
			s.metrics.AccountsLocked++
			s.logger.Warn("IP address locked due to failed login attempts",
				"ip", s.anonymizeIP(ipAddress),
				"attempts", recentAttempts,
				"lockedUntil", ipWindow.lockedUntil,
			)
		}
	}

	// Track by username
	if username != "" {
		userWindow, exists := s.userFailedLogins[username]
		if !exists {
			userWindow = &attemptWindow{}
			s.userFailedLogins[username] = userWindow
		}

		s.addAttempt(userWindow, now)

		// Check if we should lock
		recentAttempts := s.countRecentAttempts(userWindow, windowStart)
		if recentAttempts >= s.config.BruteForceThreshold {
			userWindow.lockedUntil = now.Add(s.config.LockoutDuration)
			s.metrics.AccountsLocked++
			s.logger.Warn("User account locked due to failed login attempts",
				"username", username,
				"attempts", recentAttempts,
				"lockedUntil", userWindow.lockedUntil,
			)
		}
	}

	s.metrics.FailedLoginsTracked++

	return nil
}

func (s *Service) IsLockedOut(ipAddress, username string) (bool, time.Time) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now()

	// Check IP lock
	if ipAddress != "" {
		if window, exists := s.failedAttempts[ipAddress]; exists {
			if now.Before(window.lockedUntil) {
				return true, window.lockedUntil
			}
		}
	}

	// Check user lock
	if username != "" {
		if window, exists := s.userFailedLogins[username]; exists {
			if now.Before(window.lockedUntil) {
				return true, window.lockedUntil
			}
		}
	}

	return false, time.Time{}
}

func (s *Service) ClearFailedAttempts(ipAddress, username string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if ipAddress != "" {
		delete(s.failedAttempts, ipAddress)
	}

	if username != "" {
		delete(s.userFailedLogins, username)
	}
}

func (s *Service) ListEvents(ctx context.Context, filter EventFilter) (*PaginatedEvents, error) {
	if filter.Limit <= 0 {
		filter.Limit = 100
	}
	if filter.Limit > 1000 {
		filter.Limit = 1000
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}

	var conditions []string
	var args []interface{}
	argIdx := 1

	if filter.ActorID != "" {
		conditions = append(conditions, fmt.Sprintf("actor_id = $%d", argIdx))
		args = append(args, filter.ActorID)
		argIdx++
	}
	if filter.EventType != "" {
		conditions = append(conditions, fmt.Sprintf("event_type = $%d", argIdx))
		args = append(args, string(filter.EventType))
		argIdx++
	}
	if filter.Severity != "" {
		conditions = append(conditions, fmt.Sprintf("severity = $%d", argIdx))
		args = append(args, string(filter.Severity))
		argIdx++
	}
	if !filter.Since.IsZero() {
		conditions = append(conditions, fmt.Sprintf("timestamp >= $%d", argIdx))
		args = append(args, filter.Since)
		argIdx++
	}

	whereClause := ""
	if len(conditions) > 0 {
		whereClause = "WHERE " + conditions[0]
		for _, cond := range conditions[1:] {
			whereClause += " AND " + cond
		}
	}

	query := fmt.Sprintf(`
		SELECT id, timestamp, event_type, severity, actor_id, actor_username,
		       ip_address, user_agent, details, metadata, notified
		FROM security_events
		%s
		ORDER BY timestamp DESC
		LIMIT $%d OFFSET $%d
	`, whereClause, argIdx, argIdx+1)

	args = append(args, filter.Limit, filter.Offset)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query events: %w", err)
	}
	defer rows.Close()

	events, err := s.scanEvents(rows)
	if err != nil {
		return nil, err
	}

	// Get filtered total count
	var totalCount int
	countQuery := fmt.Sprintf(`SELECT COUNT(*) FROM security_events %s`, whereClause)
	countArgs := make([]interface{}, len(args)-2)
	copy(countArgs, args[:len(args)-2])
	err = s.db.QueryRow(countQuery, countArgs...).Scan(&totalCount)
	if err != nil {
		s.logger.Error("Failed to get total event count", "error", err)
	}

	return &PaginatedEvents{
		Events:     events,
		TotalCount: totalCount,
		Limit:      filter.Limit,
		Offset:     filter.Offset,
		HasMore:    filter.Offset+len(events) < totalCount,
	}, nil
}

func (s *Service) scanEvents(rows *sql.Rows) ([]Event, error) {
	events := make([]Event, 0)

	for rows.Next() {
		var event Event
		var metadataJSON []byte

		err := rows.Scan(
			&event.ID,
			&event.Timestamp,
			&event.EventType,
			&event.Severity,
			&event.ActorID,
			&event.ActorUsername,
			&event.IPAddress,
			&event.UserAgent,
			&event.Details,
			&metadataJSON,
			&event.Notified,
		)
		if err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}

		if metadataJSON != nil {
			if err := json.Unmarshal(metadataJSON, &event.Metadata); err != nil {
				s.logger.Error("Failed to unmarshal metadata", "error", err)
			}
		}

		events = append(events, event)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate events: %w", err)
	}

	return events, nil
}

func (s *Service) GetUserSettings(ctx context.Context, userID string) (*UserSettings, error) {
	settings := &UserSettings{UserID: userID}

	query := `
		SELECT notifications_enabled, notification_frequency, notify_on_login,
		       notify_on_failed_login, notify_on_password_change, notify_on_admin_action, updated_at
		FROM user_security_settings
		WHERE user_id = $1
	`

	row := s.db.QueryRow(query, userID)
	err := row.Scan(
		&settings.NotificationsEnabled,
		&settings.NotificationFrequency,
		&settings.NotifyOnLogin,
		&settings.NotifyOnFailedLogin,
		&settings.NotifyOnPasswordChange,
		&settings.NotifyOnAdminAction,
		&settings.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		// Return default settings
		return &UserSettings{
			UserID:                 userID,
			NotificationsEnabled:   true,
			NotificationFrequency:  string(FrequencyNormal),
			NotifyOnLogin:          false,
			NotifyOnFailedLogin:    true,
			NotifyOnPasswordChange: true,
			NotifyOnAdminAction:    true,
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
		 notify_on_failed_login, notify_on_password_change, notify_on_admin_action, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (user_id) DO UPDATE SET
			notifications_enabled = EXCLUDED.notifications_enabled,
			notification_frequency = EXCLUDED.notification_frequency,
			notify_on_login = EXCLUDED.notify_on_login,
			notify_on_failed_login = EXCLUDED.notify_on_failed_login,
			notify_on_password_change = EXCLUDED.notify_on_password_change,
			notify_on_admin_action = EXCLUDED.notify_on_admin_action,
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
		WHERE timestamp > $1
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
		AND timestamp > $1
	`
	if err := s.db.QueryRow(criticalQuery, weekAgo).Scan(&stats.CriticalEvents); err != nil {
		return nil, fmt.Errorf("get critical events: %w", err)
	}

	// Get recent lockouts
	lockoutQuery := `
		SELECT COUNT(*) 
		FROM security_events 
		WHERE event_type = 'account_locked' 
		AND timestamp > $1
	`
	if err := s.db.QueryRow(lockoutQuery, weekAgo).Scan(&stats.RecentLockouts); err != nil {
		return nil, fmt.Errorf("get recent lockouts: %w", err)
	}

	// Get unique IPs
	ipQuery := `
		SELECT COUNT(DISTINCT ip_address) 
		FROM security_events 
		WHERE timestamp > $1
	`
	if err := s.db.QueryRow(ipQuery, weekAgo).Scan(&stats.UniqueIPs); err != nil {
		return nil, fmt.Errorf("get unique ips: %w", err)
	}

	return stats, nil
}

func (s *Service) CleanupOldEvents(ctx context.Context) error {
	cutoff := time.Now().UTC().Add(-time.Duration(s.config.RetentionDays) * 24 * time.Hour)

	query := `DELETE FROM security_events WHERE timestamp < $1`
	result, err := s.db.Exec(query, cutoff)
	if err != nil {
		return fmt.Errorf("delete old events: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		s.logger.Warn("Failed to get rows affected after cleanup", "error", err)
		rowsAffected = 0
	}
	s.logger.Info("Cleaned up old security events", "deleted", rowsAffected, "cutoff", cutoff)

	return nil
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

func (s *Service) cleanupRoutine() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)

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

			cancel()

		case <-s.stopWorkers:
			return
		}
	}
}

func (s *Service) anonymizeIP(ip string) string {
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return ip
	}

	if parsedIP.To4() != nil {
		// IPv4 - mask last octet
		parts := strings.Split(ip, ".")
		if len(parts) == 4 {
			return fmt.Sprintf("%s.%s.%s.xxx", parts[0], parts[1], parts[2])
		}
	} else {
		// IPv6 - mask last 64 bits
		parts := strings.Split(ip, ":")
		if len(parts) >= 4 {
			return strings.Join(parts[:4], ":") + ":xxxx:xxxx:xxxx:xxxx"
		}
	}

	return ip
}

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

func (s *Service) Close() {
	close(s.stopWorkers)
	s.workersWg.Wait()
	s.logger.Info("Security service stopped")
}

// WithTransaction executes operations within a database transaction
func (s *Service) WithTransaction(ctx context.Context, fn func(*sql.Tx) error) error {
	if s.db == nil {
		return fmt.Errorf("database not initialized")
	}
	return s.db.WithTransaction(ctx, fn)
}

// TransactionalOperation represents an operation that can be part of a transaction
type TransactionalOperation struct {
	Name string
	Fn   func(*sql.Tx) error
}

// ExecuteOperations executes multiple database operations within a single transaction
// If any operation fails, all changes are rolled back
func (s *Service) ExecuteOperations(ctx context.Context, operations []TransactionalOperation) error {
	if s.db == nil {
		return fmt.Errorf("database not initialized")
	}

	dbOps := make([]database.TransactionalOperation, len(operations))
	for i, op := range operations {
		dbOps[i] = database.TransactionalOperation{
			Name: op.Name,
			Fn:   op.Fn,
		}
	}

	return s.db.ExecuteOperations(ctx, dbOps)
}
