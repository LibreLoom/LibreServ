package middleware

import (
	"sync"
	"time"
)

// LeakyBucket is a lightweight, single-bucket limiter good for rapid UI checks.
type LeakyBucket struct {
	mu      sync.Mutex
	rate    float64 // tokens per second
	burst   float64 // max tokens
	tokens  float64
	lastRef time.Time
}

// NewLeakyBucket creates a limiter with burst capacity and refill rate.
// burst = max tokens, perSecond = refill per second.
func NewLeakyBucket(burst int, perMinute int) *LeakyBucket {
	return &LeakyBucket{
		rate:    float64(perMinute) / 60.0,
		burst:   float64(burst),
		tokens:  float64(burst),
		lastRef: time.Now(),
	}
}

// Allow returns true if a token is available.
func (l *LeakyBucket) Allow() bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(l.lastRef).Seconds()
	l.tokens += elapsed * l.rate
	if l.tokens > l.burst {
		l.tokens = l.burst
	}
	l.lastRef = now

	if l.tokens >= 1 {
		l.tokens -= 1
		return true
	}
	return false
}
