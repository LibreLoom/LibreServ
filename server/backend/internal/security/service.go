package security

import (
	"context"
	"database/sql"
	"fmt"
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

func (s *Service) Close() {
	close(s.stopWorkers)
	s.workersWg.Wait()
	s.logger.Info("Security service stopped")
}

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
