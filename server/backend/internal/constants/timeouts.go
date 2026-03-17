// Package constants provides centralized configuration constants for the application.
// All timeouts, retry limits, and magic numbers should be defined here to ensure
// consistency and make them easily configurable.
package constants

import "time"

// Default timeouts used across the application
const (
	// DefaultRequestTimeout is the standard timeout for HTTP requests
	DefaultRequestTimeout = 30 * time.Second

	// LongRequestTimeout is used for operations that may take longer
	LongRequestTimeout = 60 * time.Second

	// HealthCheckTimeout is the maximum time to wait for a health check
	HealthCheckTimeout = 60 * time.Second

	// JobProcessingTimeout is the maximum time for background job processing
	JobProcessingTimeout = 5 * time.Minute

	// DatabaseBusyTimeout is the SQLite busy timeout in milliseconds
	DatabaseBusyTimeout = 5000 * time.Millisecond

	// CaddyReloadTimeout is the timeout for Caddy configuration reloads
	CaddyReloadTimeout = 10 * time.Second

	// ACMEValidationTimeout is the timeout for ACME validation checks
	ACMEValidationTimeout = 3 * time.Second

	// SupportCommandTimeout is the default timeout for support session commands
	SupportCommandTimeout = 30 * time.Second

	// MaxSupportCommandTimeout is the maximum allowed timeout for support commands
	MaxSupportCommandTimeout = 5 * time.Minute

	// AppHealthCheckPollInterval is how often to poll during health checks
	AppHealthCheckPollInterval = 2 * time.Second
)

// Authentication and security constants
const (
	// DefaultJWTAccessTokenExpiry is the lifetime of access tokens
	DefaultJWTAccessTokenExpiry = 15 * time.Minute

	// DefaultJWTRefreshTokenExpiry is the lifetime of refresh tokens
	DefaultJWTRefreshTokenExpiry = 7 * 24 * time.Hour

	// DefaultAccountLockoutAfter is the number of failed attempts before lockout
	DefaultAccountLockoutAfter = 5

	// DefaultLockoutWindow is the time window for counting failed attempts
	DefaultLockoutWindow = 10 * time.Minute

	// DefaultLockoutDuration is how long an account remains locked
	DefaultLockoutDuration = 15 * time.Minute

	// MinPasswordLength is the minimum required password length
	MinPasswordLength = 12

	// CSRFTokenValidityPeriod is how long CSRF tokens remain valid (reduced from 24h for security)
	CSRFTokenValidityPeriod = 4 * time.Hour
)

// Validation constants
const (
	// Username length constraints
	MinUsernameLength = 3
	MaxUsernameLength = 32

	// Password length constraints
	MaxPasswordLength = 128

	// Email constraints
	MaxEmailLength = 254

	// Instance ID length constraints
	MinInstanceIDLength = 1
	MaxInstanceIDLength = 64

	// Subdomain constraints
	MaxSubdomainLength = 63

	// Search query constraints
	MaxSearchQueryLength = 100
)

// Job queue constants
const (
	// JobQueuePollInterval is how often to poll for pending jobs
	JobQueuePollInterval = 10 * time.Second

	// MaxJobRetries is the default maximum number of job retries
	MaxJobRetries = 3

	// DefaultJobPriority is the default priority for new jobs
	DefaultJobPriority = 5

	// JobRetryBackoffBase is the base multiplier for exponential backoff
	JobRetryBackoffBase = 2
)

// Database constants
const (
	// DefaultDatabaseBusyTimeoutMs is the SQLite busy timeout in milliseconds
	DefaultDatabaseBusyTimeoutMs = 5000

	// MaxDatabaseConnections is the maximum number of database connections
	MaxDatabaseConnections = 10
)

// HTTP server constants
const (
	// DefaultServerPort is the default HTTP server port
	DefaultServerPort = 8080

	// DefaultServerHost is the default HTTP server host
	DefaultServerHost = "0.0.0.0"

	// RequestTimeoutSeconds is the middleware request timeout
	RequestTimeoutSeconds = 60
)

// Status constants
const (
	// StatusPending indicates an operation is pending
	StatusPending = "pending"

	// StatusInProgress indicates an operation is in progress
	StatusInProgress = "in_progress"

	// StatusComplete indicates an operation is complete
	StatusComplete = "complete"

	// StatusFailed indicates an operation has failed
	StatusFailed = "failed"

	// StatusRunning indicates a service is running
	StatusRunning = "running"

	// StatusStopped indicates a service is stopped
	StatusStopped = "stopped"
)

// User role constants
const (
	// RoleAdmin is the administrator role
	RoleAdmin = "admin"

	// RoleUser is the standard user role
	RoleUser = "user"
)

// HTTP status code ranges
const (
	// MinSuccessStatusCode is the minimum successful HTTP status code
	MinSuccessStatusCode = 200

	// MaxSuccessStatusCode is the maximum successful HTTP status code (exclusive)
	MaxSuccessStatusCode = 300
)
