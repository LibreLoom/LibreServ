// Package jobqueue provides a persistent job queue system for ACME certificate operations.
// It supports multiple job types (issuance, renewal, validation, revocation) with
// configurable worker pools, retry logic with exponential backoff, and persistent
// storage in SQLite.
package jobqueue

import "time"

// Constants for job queue configuration
const (
	// DefaultWorkerCount is the default number of workers per pool
	DefaultWorkerCount = 2

	// DefaultQueueSize is the default size of the job queue channel
	DefaultQueueSize = 100

	// DefaultPollInterval is how often the queue polls for pending jobs
	DefaultPollInterval = 10 * time.Second

	// DefaultJobTimeout is the maximum time a job can run
	DefaultJobTimeout = 5 * time.Minute

	// DefaultPollBatchSize is the maximum number of jobs to fetch per poll
	DefaultPollBatchSize = 50
)

// Constants for retry configuration
const (
	// DefaultInitialBackoff is the initial retry delay
	DefaultInitialBackoff = 1 * time.Minute

	// DefaultMaxBackoff is the maximum retry delay cap
	DefaultMaxBackoff = 1 * time.Hour

	// DefaultRetryMultiplier is the exponential backoff multiplier
	DefaultRetryMultiplier = 2.0

	// DefaultJitterFactor is the random jitter factor (0.0 - 1.0)
	DefaultJitterFactor = 0.1
)

// Constants for job logs
const (
	// MaxJobLogs is the maximum number of log entries per job
	MaxJobLogs = 1000

	// MaxErrorLength is the maximum length of error messages stored in DB
	MaxErrorLength = 1000

	// LogTruncatePercentage is the percentage of logs to remove when truncating
	LogTruncatePercentage = 10

	// MaxLogMessageSize is the maximum size of a single log message in bytes (1KB)
	// Messages exceeding this limit will be truncated with a "..." suffix
	MaxLogMessageSize = 1024

	// MaxTotalLogSize is the maximum total size of all logs for a job in bytes (100KB)
	// When this limit is exceeded, oldest logs are removed to make room
	MaxTotalLogSize = 100 * 1024

	// TruncateSuffix is appended to log messages when they exceed MaxLogMessageSize
	TruncateSuffix = "..."
)

// Constants for default max retries by job type
const (
	// DefaultMaxRetriesIssuance is the default max retries for issuance jobs
	DefaultMaxRetriesIssuance = 3

	// DefaultMaxRetriesRenewal is the default max retries for renewal jobs
	DefaultMaxRetriesRenewal = 5

	// DefaultMaxRetriesRevocation is the default max retries for revocation jobs
	DefaultMaxRetriesRevocation = 2

	// DefaultMaxRetriesValidation is the default max retries for validation jobs
	DefaultMaxRetriesValidation = 3
)

// Constants for panic retry handling
const (
	// MaxPanicRetries is the maximum number of times a job can panic before being marked as failed permanently
	MaxPanicRetries = 3
)

// Constants for renewal scheduler
const (
	// DefaultRenewalInterval is how often to check for expiring certificates
	DefaultRenewalInterval = 24 * time.Hour

	// DefaultRenewalThreshold is how many days before expiry to trigger renewal
	DefaultRenewalThresholdDays = 30
)

// Constants for database queries
const (
	// MaxRunningJobsQueryLimit is the maximum number of running jobs to query
	MaxRunningJobsQueryLimit = 1000
)

// Constants for webhook configuration
const (
	// DefaultWebhookTimeout is the timeout for webhook HTTP requests
	DefaultWebhookTimeout = 30 * time.Second

	// DefaultWebhookMaxRetries is the maximum number of retries for failed webhook deliveries
	DefaultWebhookMaxRetries = 3

	// DefaultWebhookRetryDelay is the delay between webhook retry attempts
	DefaultWebhookRetryDelay = 1 * time.Minute

	// WebhookCleanupInterval is how often to clean up old webhook deliveries
	WebhookCleanupInterval = 24 * time.Hour

	// WebhookMaxAge is how long to keep webhook delivery records
	WebhookMaxAge = 7 * 24 * time.Hour
)
