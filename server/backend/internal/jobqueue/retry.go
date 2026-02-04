package jobqueue

import (
	"math"
	"math/rand"
	"time"
)

// RetryConfig configures the exponential backoff retry behavior
type RetryConfig struct {
	InitialBackoff time.Duration // First retry delay
	MaxBackoff     time.Duration // Maximum retry delay cap
	Multiplier     float64       // Backoff multiplier (typically 2)
	JitterFactor   float64       // Random jitter factor (0.0 - 1.0)
}

// DefaultRetryConfig returns sensible defaults for retry behavior
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		InitialBackoff: DefaultInitialBackoff,
		MaxBackoff:     DefaultMaxBackoff,
		Multiplier:     DefaultRetryMultiplier,
		JitterFactor:   DefaultJitterFactor,
	}
}

// CalculateNextRetry calculates the next retry time using capped exponential backoff
func CalculateNextRetry(createdAt time.Time, retryCount int, config RetryConfig) time.Time {
	if retryCount == 0 {
		// First retry happens after initial backoff
		return createdAt.Add(config.InitialBackoff)
	}

	// Calculate exponential backoff: initial * multiplier^retryCount
	backoff := float64(config.InitialBackoff) * math.Pow(config.Multiplier, float64(retryCount))

	// Cap at maximum backoff
	if backoff > float64(config.MaxBackoff) {
		backoff = float64(config.MaxBackoff)
	}

	// Add jitter to prevent thundering herd
	jitter := backoff * config.JitterFactor * (rand.Float64()*2 - 1) // ±JitterFactor
	backoff += jitter

	return time.Now().Add(time.Duration(backoff))
}

// ShouldRetryNow checks if a job's next retry time has been reached
func ShouldRetryNow(job *Job) bool {
	if job.NextRetryAt == nil {
		return true
	}
	return time.Now().After(*job.NextRetryAt)
}

// RetryDelay calculates the delay for a specific retry attempt without jitter
// Useful for displaying retry timing to users
func RetryDelay(retryCount int, config RetryConfig) time.Duration {
	if retryCount == 0 {
		return config.InitialBackoff
	}

	backoff := float64(config.InitialBackoff) * math.Pow(config.Multiplier, float64(retryCount))

	if backoff > float64(config.MaxBackoff) {
		return config.MaxBackoff
	}

	return time.Duration(backoff)
}

// FormatRetryDelay returns a human-readable string for the retry delay
func FormatRetryDelay(delay time.Duration) string {
	if delay < time.Minute {
		return delay.Round(time.Second).String()
	}
	return delay.Round(time.Minute).String()
}
