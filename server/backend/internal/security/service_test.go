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
	sent       int
	recipients []string
	subject    string
	body       string
}

func (n *testSecurityNotifier) SendNotification(recipients []string, subject, body string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sent++
	n.recipients = append([]string(nil), recipients...)
	n.subject = subject
	n.body = body
	return n.err
}

func (n *testSecurityNotifier) IsConfigured() bool { return n.configured }

func openSecurityDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "security.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := db.Migrate(); err != nil {
		_ = db.Close()
		t.Fatalf("migrate database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func newTestSecurityService(t *testing.T) (*Service, *database.DB, *testSecurityNotifier) {
	t.Helper()
	db := openSecurityDB(t)
	notifier := &testSecurityNotifier{configured: true}
	cfg := DefaultConfig()
	cfg.NotificationWorkers = 0
	cfg.NotificationQueueSize = 1
	cfg.BruteForceThreshold = 2
	cfg.BruteForceWindow = time.Hour
	cfg.LockoutDuration = time.Hour
	cfg.MaxAttemptsPerWindow = 2
	cfg.NotificationThrottle = time.Hour
	cfg.RetentionDays = 30
	svc := NewServiceWithConfig(db, testSecurityLogger{}, notifier, cfg)
	t.Cleanup(svc.Close)
	return svc, db, notifier
}

func insertSecurityUser(t *testing.T, db *database.DB, id, username, email, role string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO users (id, username, password_hash, email, role) VALUES (?, ?, 'hash', ?, ?)`,
		id, username, email, role,
	); err != nil {
		t.Fatalf("insert user: %v", err)
	}
}

func enabledSecuritySettings(userID string) *UserSettings {
	return &UserSettings{
		UserID:                 userID,
		NotificationsEnabled:   true,
		NotificationFrequency:  string(FrequencyInstant),
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
	}
}

func TestSecurityServiceEventLifecycle(t *testing.T) {
	svc, db, _ := newTestSecurityService(t)
	ctx := context.Background()
	insertSecurityUser(t, db, "admin-1", "admin", "admin@example.com", "admin")
	insertSecurityUser(t, db, "user-1", "alice", "alice@example.com", "user")
	if err := svc.UpdateUserSettings(ctx, enabledSecuritySettings("admin-1")); err != nil {
		t.Fatalf("update admin settings: %v", err)
	}
	if err := svc.UpdateUserSettings(ctx, enabledSecuritySettings("user-1")); err != nil {
		t.Fatalf("update user settings: %v", err)
	}

	if err := svc.RecordEvent(ctx, nil); err == nil {
		t.Fatal("expected nil event error")
	}
	if err := svc.RecordEvent(ctx, &Event{EventType: "invalid", Severity: SeverityInfo}); err == nil {
		t.Fatal("expected invalid event error")
	}
	if err := svc.RecordEvent(ctx, &Event{
		EventType: EventLoginSuccess,
		Severity:  SeverityInfo,
		Metadata:  map[string]any{"bad": func() {}},
	}); err == nil {
		t.Fatal("expected metadata marshal error")
	}

	first := &Event{
		EventType:     EventLoginFailed,
		Severity:      SeverityWarning,
		ActorID:       "user-1",
		ActorUsername: "alice",
		IPAddress:     "192.0.2.10",
		UserAgent:     "test",
		Details:       "wrong password",
		Metadata:      map[string]any{"attempt": float64(1)},
	}
	if err := svc.RecordEvent(ctx, first); err != nil {
		t.Fatalf("record first event: %v", err)
	}
	if first.ID == 0 || first.Timestamp.IsZero() {
		t.Fatalf("record event did not populate fields: %+v", first)
	}
	second := &Event{
		Timestamp: time.Now().UTC(),
		EventType: EventAccountLocked,
		Severity:  SeverityCritical,
		ActorID:   "user-1",
		IPAddress: "192.0.2.10",
		Details:   "too many attempts",
	}
	if err := svc.RecordEvent(ctx, second); err != nil {
		t.Fatalf("record second event: %v", err)
	}
	if svc.GetMetrics().NotificationsDropped != 1 {
		t.Fatalf("expected full notification queue to drop one event: %+v", svc.GetMetrics())
	}

	page, err := svc.ListEvents(ctx, EventFilter{
		ActorID:   "user-1",
		EventType: EventLoginFailed,
		Severity:  SeverityWarning,
		Since:     time.Now().Add(-time.Hour),
		Limit:     1,
		Offset:    -1,
	})
	if err != nil {
		t.Fatalf("list filtered events: %v", err)
	}
	if len(page.Events) != 1 || page.TotalCount != 1 || page.Events[0].Metadata["attempt"] != float64(1) {
		t.Fatalf("unexpected page: %+v", page)
	}
	all, err := svc.ListEvents(ctx, EventFilter{Limit: 5000})
	if err != nil || len(all.Events) != 2 || all.Limit != 1000 {
		t.Fatalf("all events = %+v, %v", all, err)
	}

	stats, err := svc.GetStats(ctx)
	if err != nil {
		t.Fatalf("get stats: %v", err)
	}
	if stats.TotalEvents != 2 || stats.FailedLogins != 1 || stats.CriticalEvents != 1 ||
		stats.RecentLockouts != 1 || stats.UniqueIPs != 1 {
		t.Fatalf("unexpected security stats: %+v", stats)
	}

	recipients, err := svc.getNotificationRecipients(first)
	if err != nil {
		t.Fatalf("notification recipients: %v", err)
	}
	if len(recipients) != 2 {
		t.Fatalf("recipients = %v, want admin and actor", recipients)
	}
}

func TestSecurityServiceSettingsNotificationAndCleanup(t *testing.T) {
	svc, db, notifier := newTestSecurityService(t)
	ctx := context.Background()

	defaults, err := svc.GetUserSettings(ctx, "missing")
	if err != nil || !defaults.NotificationsEnabled || defaults.NotificationFrequency != string(FrequencyNormal) {
		t.Fatalf("default settings = %+v, %v", defaults, err)
	}
	if err := svc.UpdateUserSettings(ctx, nil); err == nil {
		t.Fatal("expected nil settings error")
	}
	insertSecurityUser(t, db, "admin-1", "admin", "admin@example.com", "admin")
	settings := enabledSecuritySettings("admin-1")
	settings.Use12HourTime = true
	if err := svc.UpdateUserSettings(ctx, settings); err != nil {
		t.Fatalf("update settings: %v", err)
	}
	got, err := svc.GetUserSettings(ctx, "admin-1")
	if err != nil || !got.Use12HourTime || !got.NotifyOnLogin {
		t.Fatalf("stored settings = %+v, %v", got, err)
	}

	event := &Event{
		EventType: EventLoginSuccess,
		Severity:  SeverityInfo,
		Timestamp: time.Now(),
		IPAddress: "203.0.113.5",
	}
	svc.processNotification(event)
	if notifier.sent != 1 || len(notifier.recipients) != 1 ||
		!strings.Contains(notifier.subject, "Successful Login") ||
		!strings.Contains(notifier.body, "LibreServ →") {
		t.Fatalf("notification not sent correctly: %+v", notifier)
	}
	svc.processNotification(event)
	if notifier.sent != 1 {
		t.Fatalf("throttled notification was sent: %d", notifier.sent)
	}
	notifier.configured = false
	svc.processNotification(&Event{EventType: EventAccountLocked, Severity: SeverityCritical})
	if notifier.sent != 1 {
		t.Fatal("unconfigured notifier should not send")
	}

	old := time.Now().Add(-60 * 24 * time.Hour)
	if _, err := db.Exec(
		`INSERT INTO security_events (timestamp, event_type, severity, details) VALUES (?, ?, ?, '')`,
		old, EventLogout, SeverityInfo,
	); err != nil {
		t.Fatalf("insert old event: %v", err)
	}
	if err := svc.CleanupOldEvents(ctx); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM security_events`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("events after cleanup = %d, %v", count, err)
	}
}

func TestSecurityServiceLockoutsMetricsAndHealth(t *testing.T) {
	svc, _, notifier := newTestSecurityService(t)

	if err := svc.RecordFailedLogin("alice", "192.168.1.42", "agent", "bad password"); err != nil {
		t.Fatalf("record first failure: %v", err)
	}
	if locked, _ := svc.IsLockedOut("192.168.1.42", "alice"); locked {
		t.Fatal("locked too early")
	}
	if err := svc.RecordFailedLogin("alice", "192.168.1.42", "agent", "bad password"); err != nil {
		t.Fatalf("record second failure: %v", err)
	}
	if locked, until := svc.IsLockedOut("192.168.1.42", "alice"); !locked || until.Before(time.Now()) {
		t.Fatalf("expected active lockout, got %v until %v", locked, until)
	}
	metrics := svc.GetMetrics()
	if metrics.FailedLoginsTracked != 2 || metrics.AccountsLocked != 2 {
		t.Fatalf("unexpected metrics: %+v", metrics)
	}
	svc.ClearFailedAttempts("192.168.1.42", "alice")
	if locked, _ := svc.IsLockedOut("192.168.1.42", "alice"); locked {
		t.Fatal("lockout was not cleared")
	}

	for input, want := range map[string]string{
		"192.168.1.42": "192.168.1.xxx",
		"2001:db8::1":  "2001:db8::1:xxxx:xxxx:xxxx:xxxx",
		"invalid":      "invalid",
	} {
		if got := svc.anonymizeIP(input); got != want {
			t.Errorf("anonymizeIP(%q) = %q, want %q", input, got, want)
		}
	}

	svc.IncrementEventsRecorded()
	svc.IncrementNotificationsSent()
	svc.IncrementNotificationsDropped()
	svc.IncrementFailedLoginsTracked()
	svc.IncrementAccountsLocked()
	health := svc.GetHealth()
	if health["status"] != "healthy" || health["notification_configured"] != notifier.configured {
		t.Fatalf("unexpected health: %+v", health)
	}
}

func TestSecurityServiceTransactions(t *testing.T) {
	svc, db, _ := newTestSecurityService(t)
	ctx := context.Background()

	if err := svc.WithTransaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO security_events (event_type, severity, details) VALUES ('logout', 'info', 'tx')`)
		return err
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}
	errBoom := errors.New("boom")
	err := svc.ExecuteOperations(ctx, []TransactionalOperation{
		{Name: "insert", Fn: func(tx *sql.Tx) error {
			_, execErr := tx.Exec(`INSERT INTO security_events (event_type, severity, details) VALUES ('logout', 'info', 'rolled back')`)
			return execErr
		}},
		{Name: "fail", Fn: func(*sql.Tx) error { return errBoom }},
	})
	if err == nil || !strings.Contains(err.Error(), "fail") {
		t.Fatalf("expected named operation error, got %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM security_events`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("transaction rollback count = %d, %v", count, err)
	}

	nilSvc := &Service{}
	if err := nilSvc.WithTransaction(ctx, func(*sql.Tx) error { return nil }); err == nil {
		t.Fatal("expected uninitialized transaction error")
	}
	if err := nilSvc.ExecuteOperations(ctx, nil); err == nil {
		t.Fatal("expected uninitialized operations error")
	}
}
