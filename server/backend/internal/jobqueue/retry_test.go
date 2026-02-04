package jobqueue

import (
	"testing"
	"time"
)

func TestCalculateNextRetry(t *testing.T) {
	config := RetryConfig{
		InitialBackoff: 1 * time.Minute,
		MaxBackoff:     1 * time.Hour,
		Multiplier:     2.0,
		JitterFactor:   0.0, // No jitter for predictable tests
	}

	createdAt := time.Now()

	tests := []struct {
		name       string
		retryCount int
		minDelay   time.Duration
		maxDelay   time.Duration
	}{
		{
			name:       "first retry",
			retryCount: 0,
			minDelay:   1 * time.Minute,
			maxDelay:   1 * time.Minute,
		},
		{
			name:       "second retry",
			retryCount: 1,
			minDelay:   2 * time.Minute,
			maxDelay:   2 * time.Minute,
		},
		{
			name:       "third retry",
			retryCount: 2,
			minDelay:   4 * time.Minute,
			maxDelay:   4 * time.Minute,
		},
		{
			name:       "fourth retry",
			retryCount: 3,
			minDelay:   8 * time.Minute,
			maxDelay:   8 * time.Minute,
		},
		{
			name:       "fifth retry",
			retryCount: 4,
			minDelay:   16 * time.Minute,
			maxDelay:   16 * time.Minute,
		},
		{
			name:       "sixth retry - should cap",
			retryCount: 5,
			minDelay:   32 * time.Minute,
			maxDelay:   32 * time.Minute,
		},
		{
			name:       "seventh retry - should cap at max",
			retryCount: 6,
			minDelay:   1 * time.Hour,
			maxDelay:   1 * time.Hour,
		},
		{
			name:       "many retries - should stay capped",
			retryCount: 10,
			minDelay:   1 * time.Hour,
			maxDelay:   1 * time.Hour,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			nextRetry := CalculateNextRetry(createdAt, tt.retryCount, config)
			delay := nextRetry.Sub(createdAt)

			// Allow 1 second tolerance for processing time
			tolerance := 1 * time.Second
			if delay < tt.minDelay {
				t.Errorf("delay %v is less than minimum %v", delay, tt.minDelay)
			}
			if delay > tt.maxDelay+tolerance {
				t.Errorf("delay %v is greater than maximum %v (with tolerance)", delay, tt.maxDelay)
			}
		})
	}
}

func TestCalculateNextRetryWithJitter(t *testing.T) {
	config := RetryConfig{
		InitialBackoff: 10 * time.Minute,
		MaxBackoff:     1 * time.Hour,
		Multiplier:     2.0,
		JitterFactor:   0.1, // 10% jitter
	}

	createdAt := time.Now()

	// Run multiple times to account for randomness
	for i := 0; i < 10; i++ {
		nextRetry := CalculateNextRetry(createdAt, 1, config) // 2nd retry = 20 min base
		delay := nextRetry.Sub(createdAt)

		// With 10% jitter on 20 min, delay should be between 18-22 min
		minExpected := 18 * time.Minute
		maxExpected := 22 * time.Minute

		if delay < minExpected || delay > maxExpected {
			t.Errorf("jittered delay %v is outside expected range [%v, %v]",
				delay, minExpected, maxExpected)
		}
	}
}

func TestRetryDelay(t *testing.T) {
	config := RetryConfig{
		InitialBackoff: 1 * time.Minute,
		MaxBackoff:     1 * time.Hour,
		Multiplier:     2.0,
		JitterFactor:   0.0,
	}

	tests := []struct {
		retryCount int
		expected   time.Duration
	}{
		{0, 1 * time.Minute},
		{1, 2 * time.Minute},
		{2, 4 * time.Minute},
		{3, 8 * time.Minute},
		{4, 16 * time.Minute},
		{5, 32 * time.Minute},
		{6, 1 * time.Hour},  // Capped
		{10, 1 * time.Hour}, // Still capped
	}

	for _, tt := range tests {
		delay := RetryDelay(tt.retryCount, config)
		if delay != tt.expected {
			t.Errorf("RetryDelay(%d) = %v, expected %v", tt.retryCount, delay, tt.expected)
		}
	}
}

func TestFormatRetryDelay(t *testing.T) {
	tests := []struct {
		delay    time.Duration
		expected string
	}{
		{30 * time.Second, "30s"},
		{90 * time.Second, "2m0s"}, // Rounds up to nearest minute
		{5 * time.Minute, "5m0s"},
		{90 * time.Minute, "1h30m0s"},
		{2 * time.Hour, "2h0m0s"},
	}

	for _, tt := range tests {
		result := FormatRetryDelay(tt.delay)
		if result != tt.expected {
			t.Errorf("FormatRetryDelay(%v) = %s, expected %s", tt.delay, result, tt.expected)
		}
	}
}

func TestShouldRetryNow(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour)
	future := time.Now().Add(1 * time.Hour)

	tests := []struct {
		name     string
		job      *Job
		expected bool
	}{
		{
			name: "no retry time set",
			job: &Job{
				NextRetryAt: nil,
			},
			expected: true,
		},
		{
			name: "retry time in past",
			job: &Job{
				NextRetryAt: &past,
			},
			expected: true,
		},
		{
			name: "retry time in future",
			job: &Job{
				NextRetryAt: &future,
			},
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ShouldRetryNow(tt.job)
			if result != tt.expected {
				t.Errorf("ShouldRetryNow() = %v, expected %v", result, tt.expected)
			}
		})
	}
}

func TestDefaultRetryConfig(t *testing.T) {
	config := DefaultRetryConfig()

	if config.InitialBackoff != 1*time.Minute {
		t.Errorf("InitialBackoff = %v, expected 1m", config.InitialBackoff)
	}
	if config.MaxBackoff != 1*time.Hour {
		t.Errorf("MaxBackoff = %v, expected 1h", config.MaxBackoff)
	}
	if config.Multiplier != 2.0 {
		t.Errorf("Multiplier = %v, expected 2.0", config.Multiplier)
	}
	if config.JitterFactor != 0.1 {
		t.Errorf("JitterFactor = %v, expected 0.1", config.JitterFactor)
	}
}
