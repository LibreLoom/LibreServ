package email

import (
	"fmt"
	"sync"
	"time"
)

// RateLimiter provides rate limiting for email sending
// to prevent abuse and avoid hitting SMTP provider limits
type RateLimiter struct {
	sender      *Sender
	mu          sync.Mutex
	lastSent    time.Time
	minInterval time.Duration
	dailyCount  int
	maxDaily    int
	dayStart    time.Time
}

// RateLimitConfig configures the rate limiter
type RateLimitConfig struct {
	MinInterval    time.Duration // Minimum time between emails
	MaxDailyEmails int           // Maximum emails per day (0 = unlimited)
}

// DefaultRateLimitConfig returns sensible defaults
func DefaultRateLimitConfig() RateLimitConfig {
	return RateLimitConfig{
		MinInterval:    5 * time.Second, // Max 1 email per 5 seconds
		MaxDailyEmails: 100,             // Max 100 emails per day
	}
}

// NewRateLimiter creates a new rate-limited email sender
func NewRateLimiter(sender *Sender, cfg RateLimitConfig) *RateLimiter {
	if cfg.MinInterval <= 0 {
		cfg.MinInterval = DefaultRateLimitConfig().MinInterval
	}

	return &RateLimiter{
		sender:      sender,
		minInterval: cfg.MinInterval,
		maxDaily:    cfg.MaxDailyEmails,
		dayStart:    time.Now(),
	}
}

// Send sends an email with rate limiting
func (rl *RateLimiter) Send(to []string, subject, body string) error {
	rl.mu.Lock()

	// Check if we need to reset daily counter
	now := time.Now()
	if now.Sub(rl.dayStart) > 24*time.Hour {
		rl.dailyCount = 0
		rl.dayStart = now
	}

	// Check daily limit
	if rl.maxDaily > 0 && rl.dailyCount >= rl.maxDaily {
		rl.mu.Unlock()
		return fmt.Errorf("daily email limit reached (%d emails)", rl.maxDaily)
	}

	// Check interval and calculate sleep time if needed
	var sleepTime time.Duration
	if !rl.lastSent.IsZero() {
		timeSinceLast := now.Sub(rl.lastSent)
		if timeSinceLast < rl.minInterval {
			sleepTime = rl.minInterval - timeSinceLast
		}
	}

	// Release lock before sleeping to avoid blocking other operations
	rl.mu.Unlock()

	// Sleep outside the lock
	if sleepTime > 0 {
		time.Sleep(sleepTime)
	}

	// Send the email (outside the lock to allow concurrent sends after rate limit)
	if err := rl.sender.Send(to, subject, body); err != nil {
		return err
	}

	// Update state with lock
	rl.mu.Lock()
	rl.lastSent = time.Now()
	rl.dailyCount++
	rl.mu.Unlock()

	return nil
}

// CanSend returns true if an email can be sent without violating rate limits
func (rl *RateLimiter) CanSend() bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	// Check if we need to reset daily counter
	now := time.Now()
	if now.Sub(rl.dayStart) > 24*time.Hour {
		rl.dailyCount = 0
		rl.dayStart = now
	}

	// Check daily limit
	if rl.maxDaily > 0 && rl.dailyCount >= rl.maxDaily {
		return false
	}

	// Check interval
	if !rl.lastSent.IsZero() {
		timeSinceLast := now.Sub(rl.lastSent)
		if timeSinceLast < rl.minInterval {
			return false
		}
	}

	return true
}

// Stats returns current rate limiter statistics
func (rl *RateLimiter) Stats() map[string]interface{} {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()

	// Reset counter if needed for accurate stats
	if now.Sub(rl.dayStart) > 24*time.Hour {
		rl.dailyCount = 0
		rl.dayStart = now
	}

	return map[string]interface{}{
		"emails_today":      rl.dailyCount,
		"max_daily":         rl.maxDaily,
		"min_interval":      rl.minInterval.Seconds(),
		"seconds_remaining": 24*time.Hour - now.Sub(rl.dayStart),
	}
}

// Reset resets the rate limiter state
func (rl *RateLimiter) Reset() {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	rl.dailyCount = 0
	rl.dayStart = time.Now()
	rl.lastSent = time.Time{}
}
