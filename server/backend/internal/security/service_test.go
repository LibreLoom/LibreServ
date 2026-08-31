package security

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type testSecurityLogger struct{}

func (testSecurityLogger) Info(string, ...any)  {}
func (testSecurityLogger) Error(string, ...any) {}
func (testSecurityLogger) Debug(string, ...any) {}
func (testSecurityLogger) Warn(string, ...any)  {}

type testSecurityNotifier struct {
	mu         sync.Mutex
	configured bool
	err        error
	recipients []string
	subject    string
	body       string
	calls      int
}

func (n *testSecurityNotifier) IsConfigured() bool { return n.configured }
func (n *testSecurityNotifier) SendNotification(recipients []string, subject, body string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls++
	n.recipients = append([]string(nil), recipients...)
	n.subject = subject
	n.body = body
	return n.err
}

func openSecurityTestDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "security.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	schema := `
		CREATE TABLE users (
			id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL, email TEXT, role TEXT DEFAULT 'user'
		);
		CREATE TABLE security_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			event_type TEXT NOT NULL, severity TEXT NOT NULL,
			actor_id TEXT, actor_username TEXT, ip_address TEXT,
			user_agent TEXT, details TEXT, metadata JSON, notified BOOLEAN DEFAULT 0
		);
		CREATE TABLE user_security_settings (
			user_id TEXT PRIMARY KEY,
			notifications_enabled BOOLEAN DEFAULT 1,
			notification_frequency TEXT DEFAULT 'normal',
			notify_on_login BOOLEAN DEFAULT 1,
			notify_on_failed_login BOOLEAN DEFAULT 1,
			notify_on_password_change BOOLEAN DEFAULT 1,
			notify_on_admin_action BOOLEAN DEFAULT 1,
			notify_on_app_updates BOOLEAN DEFAULT 1,
			notify_on_user_management BOOLEAN DEFAULT 1,
			notify_on_health_alert BOOLEAN DEFAULT 1,
			notify_on_disk_warning BOOLEAN DEFAULT 1,
			notify_on_docker_failure BOOLEAN DEFAULT 1,
			notify_on_database_issue BOOLEAN DEFAULT 1,
			use_12_hour_time BOOLEAN DEFAULT 0,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
	`
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func newTestSecurityService(t *testing.T, db *database.DB, notifier *testSecurityNotifier, queueSize int) *Service {
	t.Helper()
	cfg := DefaultConfig()
	cfg.NotificationWorkers = 0
	cfg.NotificationQueueSize = queueSize
	cfg.BruteForceThreshold = 2
	cfg.BruteForceWindow = time.Minute
	cfg.LockoutDuration = time.Minute
	cfg.NotificationThrottle = time.Hour
	cfg.MaxAttemptsPerWindow = 3
	svc := NewServiceWithConfig(db, testSecurityLogger{}, notifier, cfg)
	t.Cleanup(svc.Close)
	return svc
}

func TestDefaultConfigAndNotificationSelection(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.BruteForceThreshold != 5 || cfg.NotificationWorkers != 5 ||
		cfg.NotificationQueueSize != 100 || cfg.MaxAttemptsPerWindow != 1000 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	svc := &Service{}
	notified := map[EventType]bool{
		EventAccountLocked: true, EventSuspiciousActivity: true, EventBruteForceDetected: true,
		EventTokenReuse: true, EventTokenRevoked: true, EventLoginSuccess: true,
		EventLoginFailed: true, EventPasswordChanged: true, EventPasswordReset: true,
		EventAdminAction: true, EventSettingsChanged: true, EventConfigChanged: true,
		EventAppInstalled: true, EventAppUpdated: true, EventAppRemoved: true,
		EventUserCreated: true, EventUserDeleted: true, EventLogout: false,
		EventRouteCreated: false,
	}
	for typ, want := range notified {
		if got := svc.shouldNotify(&Event{EventType: typ}); got != want {
			t.Errorf("shouldNotify(%q) = %v, want %v", typ, got, want)
		}
	}
}

func TestRecordListStatsAndCleanupEvents(t *testing.T) {
	ctx := context.Background()
	db := openSecurityTestDB(t)
	notifier := &testSecurityNotifier{}
	svc := newTestSecurityService(t, db, notifier, 1)

	if err := svc.RecordEvent(ctx, nil); err == nil {
		t.Fatal("expected nil event error")
	}
	if err := svc.RecordEvent(ctx, &Event{EventType: "bad", Severity: SeverityInfo}); err == nil {
		t.Fatal("expected invalid event error")
	}
	if err := svc.RecordEvent(ctx, &Event{
		EventType: EventLoginSuccess, Severity: SeverityInfo,
		Metadata: map[string]interface{}{"bad": func() {}},
	}); err == nil || !strings.Contains(err.Error(), "marshal metadata") {
		t.Fatalf("metadata error = %v", err)
	}

	old := &Event{
		Timestamp: time.Now().UTC().Add(-10 * 24 * time.Hour),
		EventType: EventLoginFailed, Severity: SeverityWarning,
		ActorID: "old-user", IPAddress: "10.0.0.1", Details: "old",
	}
	if err := svc.RecordEvent(ctx, old); err != nil {
		t.Fatalf("record old event: %v", err)
	}
	recent := &Event{
		EventType: EventLoginSuccess, Severity: SeverityCritical,
		ActorID: "user-1", ActorUsername: "alice", IPAddress: "10.0.0.2",
		UserAgent: "browser", Details: "signed in",
		Metadata: map[string]interface{}{"method": "password"}, Notified: true,
	}
	if err := svc.RecordEvent(ctx, recent); err != nil {
		t.Fatalf("record recent event: %v", err)
	}
	if recent.ID == 0 || recent.Timestamp.IsZero() {
		t.Fatalf("record did not populate ID/timestamp: %+v", recent)
	}
	metrics := svc.GetMetrics()
	if metrics.EventsRecorded != 2 || metrics.NotificationsDropped != 1 || metrics.QueueDepth != 1 {
		t.Fatalf("unexpected metrics after queue overflow: %+v", metrics)
	}

	page, err := svc.ListEvents(ctx, EventFilter{Limit: -1, Offset: -5})
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if page.TotalCount != 2 || len(page.Events) != 2 || page.Limit != 100 || page.Offset != 0 {
		t.Fatalf("unexpected page: %+v", page)
	}
	filtered, err := svc.ListEvents(ctx, EventFilter{
		ActorID: "user-1", EventType: EventLoginSuccess, Severity: SeverityCritical,
		Since: time.Now().Add(-time.Hour), Limit: 5000,
	})
	if err != nil {
		t.Fatalf("filtered ListEvents: %v", err)
	}
	if len(filtered.Events) != 1 || filtered.Limit != 1000 ||
		filtered.Events[0].Metadata["method"] != "password" {
		t.Fatalf("unexpected filtered events: %+v", filtered)
	}
	paged, err := svc.ListEvents(ctx, EventFilter{Limit: 1})
	if err != nil || !paged.HasMore {
		t.Fatalf("expected another page: %+v, %v", paged, err)
	}

	stats, err := svc.GetStats(ctx)
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if stats.TotalEvents != 2 || stats.SuccessfulLogins != 1 || stats.FailedLogins != 0 ||
		stats.CriticalEvents != 1 || stats.UniqueIPs != 1 {
		t.Fatalf("unexpected stats: %+v", stats)
	}

	svc.config.RetentionDays = 5
	if err := svc.CleanupOldEvents(ctx); err != nil {
		t.Fatalf("CleanupOldEvents: %v", err)
	}
	remaining, err := svc.ListEvents(ctx, EventFilter{})
	if err != nil || remaining.TotalCount != 1 {
		t.Fatalf("events after cleanup = %+v, %v", remaining, err)
	}
}

func TestUserSettingsDefaultsAndUpsert(t *testing.T) {
	ctx := context.Background()
	db := openSecurityTestDB(t)
	svc := newTestSecurityService(t, db, &testSecurityNotifier{}, 1)
	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash, email, role) VALUES ('user-1', 'alice', 'hash', 'a@example.com', 'user')`); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	defaults, err := svc.GetUserSettings(ctx, "user-1")
	if err != nil {
		t.Fatalf("GetUserSettings defaults: %v", err)
	}
	if !defaults.NotificationsEnabled || !defaults.NotifyOnLogin ||
		defaults.NotificationFrequency != string(FrequencyNormal) {
		t.Fatalf("unexpected defaults: %+v", defaults)
	}
	if err := svc.UpdateUserSettings(ctx, nil); err == nil {
		t.Fatal("expected nil settings error")
	}
	settings := &UserSettings{
		UserID: "user-1", NotificationsEnabled: true,
		NotificationFrequency: string(FrequencyDigest),
		NotifyOnFailedLogin:   true, NotifyOnDatabaseIssue: true, Use12HourTime: true,
	}
	if err := svc.UpdateUserSettings(ctx, settings); err != nil {
		t.Fatalf("UpdateUserSettings insert: %v", err)
	}
	got, err := svc.GetUserSettings(ctx, "user-1")
	if err != nil || got.NotificationFrequency != string(FrequencyDigest) ||
		!got.NotifyOnFailedLogin || !got.Use12HourTime {
		t.Fatalf("stored settings = %+v, %v", got, err)
	}
	settings.NotificationFrequency = string(FrequencyInstant)
	settings.NotifyOnLogin = true
	if err := svc.UpdateUserSettings(ctx, settings); err != nil {
		t.Fatalf("UpdateUserSettings update: %v", err)
	}
	got, _ = svc.GetUserSettings(ctx, "user-1")
	if got.NotificationFrequency != string(FrequencyInstant) || !got.NotifyOnLogin {
		t.Fatalf("updated settings = %+v", got)
	}
}

func TestFailedLoginLockoutClearAndMetrics(t *testing.T) {
	db := openSecurityTestDB(t)
	svc := newTestSecurityService(t, db, &testSecurityNotifier{}, 1)
	if err := svc.RecordFailedLogin("alice", "192.168.1.25", "browser", "wrong password"); err != nil {
		t.Fatalf("RecordFailedLogin: %v", err)
	}
	if locked, _ := svc.IsLockedOut("192.168.1.25", "alice"); locked {
		t.Fatal("first attempt should not lock")
	}
	if err := svc.RecordFailedLogin("alice", "192.168.1.25", "browser", "wrong password"); err != nil {
		t.Fatalf("RecordFailedLogin: %v", err)
	}
	locked, until := svc.IsLockedOut("192.168.1.25", "alice")
	if !locked || !until.After(time.Now()) {
		t.Fatalf("expected active lockout, got %v until %v", locked, until)
	}
	svc.RecordFailedLogin("alice", "192.168.1.25", "", "")
	svc.RecordFailedLogin("alice", "192.168.1.25", "", "")
	if got := len(svc.failedAttempts["192.168.1.25"].attempts); got > svc.config.MaxAttemptsPerWindow {
		t.Fatalf("attempt window grew to %d", got)
	}
	metrics := svc.GetMetrics()
	if metrics.FailedLoginsTracked != 4 || metrics.AccountsLocked == 0 {
		t.Fatalf("unexpected lockout metrics: %+v", metrics)
	}
	svc.ClearFailedAttempts("192.168.1.25", "alice")
	if locked, _ := svc.IsLockedOut("192.168.1.25", "alice"); locked {
		t.Fatal("ClearFailedAttempts did not unlock")
	}

	svc.IncrementEventsRecorded()
	svc.IncrementNotificationsSent()
	svc.IncrementNotificationsDropped()
	svc.IncrementFailedLoginsTracked()
	svc.IncrementAccountsLocked()
	metrics = svc.GetMetrics()
	if metrics.EventsRecorded != 1 || metrics.NotificationsSent != 1 ||
		metrics.NotificationsDropped != 1 || metrics.FailedLoginsTracked != 5 {
		t.Fatalf("increment helpers failed: %+v", metrics)
	}
}

func TestNotificationRecipientsProcessingThrottleAndHealth(t *testing.T) {
	db := openSecurityTestDB(t)
	notifier := &testSecurityNotifier{configured: true}
	svc := newTestSecurityService(t, db, notifier, 2)
	if _, err := db.Exec(`
		INSERT INTO users (id, username, password_hash, email, role) VALUES
			('admin-1', 'admin', 'hash', 'admin@example.com', 'admin'),
			('user-1', 'alice', 'hash', 'alice@example.com', 'user');
	`); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	for _, userID := range []string{"admin-1", "user-1"} {
		if _, err := db.Exec(`
			INSERT INTO user_security_settings (
				user_id, notifications_enabled, notification_frequency,
				notify_on_login, notify_on_failed_login, notify_on_password_change,
				notify_on_admin_action, notify_on_app_updates, notify_on_user_management,
				notify_on_health_alert, notify_on_disk_warning, notify_on_docker_failure,
				notify_on_database_issue, use_12_hour_time
			) VALUES (?, 1, 'normal', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0)
		`, userID); err != nil {
			t.Fatalf("insert settings: %v", err)
		}
	}
	event := &Event{
		EventType: EventLoginFailed, Severity: SeverityWarning, ActorID: "user-1",
		IPAddress: "192.168.1.2", Timestamp: time.Now(), Details: "wrong password",
	}
	recipients, err := svc.getNotificationRecipients(event)
	if err != nil || len(recipients) != 2 {
		t.Fatalf("recipients = %v, %v", recipients, err)
	}
	svc.processNotification(event)
	if notifier.calls != 1 || len(notifier.recipients) != 2 ||
		!strings.Contains(notifier.subject, "Failed Login") ||
		!strings.Contains(notifier.body, "Settings → Security") {
		t.Fatalf("notification = %+v", notifier)
	}
	svc.processNotification(event)
	if notifier.calls != 1 {
		t.Fatal("throttle should suppress duplicate notification")
	}

	event.IPAddress = "192.168.1.3"
	notifier.err = errors.New("send failed")
	svc.processNotification(event)
	if notifier.calls != 2 {
		t.Fatal("send error path was not exercised")
	}
	notifier.configured = false
	event.IPAddress = "192.168.1.4"
	svc.processNotification(event)
	if notifier.calls != 2 {
		t.Fatal("unconfigured notifier should not send")
	}

	health := svc.GetHealth()
	if health["status"] != "healthy" || health["workers"] != 0 ||
		health["notification_configured"] != false {
		t.Fatalf("unexpected health: %+v", health)
	}
	if got := svc.anonymizeIP("192.168.1.25"); got != "192.168.1.xxx" {
		t.Fatalf("IPv4 anonymized as %q", got)
	}
	if got := svc.anonymizeIP("2001:db8:1:2:3:4:5:6"); got != "2001:db8:1:2:xxxx:xxxx:xxxx:xxxx" {
		t.Fatalf("IPv6 anonymized as %q", got)
	}
	if got := svc.anonymizeIP("not-an-ip"); got != "not-an-ip" {
		t.Fatalf("invalid IP changed to %q", got)
	}
}

func TestTransactionsAndDatabaseErrors(t *testing.T) {
	ctx := context.Background()
	nilService := &Service{}
	if err := nilService.WithTransaction(ctx, func(*sql.Tx) error { return nil }); err == nil {
		t.Fatal("expected nil database transaction error")
	}
	if err := nilService.ExecuteOperations(ctx, nil); err == nil {
		t.Fatal("expected nil database operations error")
	}

	db := openSecurityTestDB(t)
	svc := newTestSecurityService(t, db, &testSecurityNotifier{}, 1)
	if _, err := db.Exec(`CREATE TABLE transaction_test (value TEXT)`); err != nil {
		t.Fatalf("create transaction table: %v", err)
	}
	if err := svc.WithTransaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO transaction_test (value) VALUES ('committed')`)
		return err
	}); err != nil {
		t.Fatalf("WithTransaction: %v", err)
	}
	errBoom := errors.New("boom")
	err := svc.ExecuteOperations(ctx, []TransactionalOperation{
		{Name: "insert", Fn: func(tx *sql.Tx) error {
			_, execErr := tx.Exec(`INSERT INTO transaction_test (value) VALUES ('rolled-back')`)
			return execErr
		}},
		{Name: "fail", Fn: func(*sql.Tx) error { return errBoom }},
	})
	if err == nil || !strings.Contains(err.Error(), "operation fail") {
		t.Fatalf("ExecuteOperations error = %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM transaction_test`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("transaction row count = %d, %v", count, err)
	}
}
