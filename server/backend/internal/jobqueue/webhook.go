package jobqueue

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// WebhookPayload represents the data sent in a webhook notification
type WebhookPayload struct {
	JobID      string    `json:"job_id"`
	JobType    string    `json:"job_type"`
	Domain     string    `json:"domain"`
	Status     string    `json:"status"`
	Error      string    `json:"error,omitempty"`
	RetryCount int       `json:"retry_count"`
	Timestamp  time.Time `json:"timestamp"`
	Duration   string    `json:"duration,omitempty"`
	WebhookID  string    `json:"webhook_id"`
}

// WebhookStatus represents the delivery status of a webhook
type WebhookStatus int

const (
	WebhookStatusPending WebhookStatus = iota
	WebhookStatusDelivered
	WebhookStatusFailed
	WebhookStatusMaxRetriesExceeded
)

// WebhookDelivery tracks a single webhook delivery attempt
type WebhookDelivery struct {
	ID         string
	WebhookURL string
	Payload    WebhookPayload
	Status     WebhookStatus
	Attempts   int
	LastError  string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// WebhookConfig configures webhook behavior
type WebhookConfig struct {
	// Timeout for webhook HTTP requests
	Timeout time.Duration
	// MaxRetries for failed webhook deliveries
	MaxRetries int
	// RetryDelay between webhook retry attempts
	RetryDelay time.Duration
	// AllowPrivateIPs allows webhook URLs with private IP addresses (for development)
	AllowPrivateIPs bool
	// RequireHTTPS enforces HTTPS-only webhook URLs (recommended for production)
	RequireHTTPS bool
	// MaxConcurrentWebhooks limits the number of concurrent webhook deliveries
	MaxConcurrentWebhooks int
}

// WebhookService handles webhook delivery with retries
type WebhookService struct {
	config     WebhookConfig
	client     *http.Client
	logger     *slog.Logger
	mu         sync.RWMutex
	deliveries map[string]*WebhookDelivery
	stopCh     chan struct{}
	started    bool
	semaphore  chan struct{}
}

// Start begins the background cleanup goroutine
func (ws *WebhookService) Start() {
	ws.mu.Lock()
	defer ws.mu.Unlock()

	if ws.started {
		return
	}

	ws.started = true
	go ws.cleanupLoop()
	ws.logger.Info("webhook service started")
}

// Stophalts the webhook service and cleanup goroutine
func (ws *WebhookService) Stop() {
	ws.mu.Lock()
	if !ws.started {
		ws.mu.Unlock()
		return
	}
	ws.started = false
	ws.mu.Unlock()

	close(ws.stopCh)
	ws.logger.Info("webhook service stopped")
}

// cleanupLoop periodically removes old webhook deliveries
func (ws *WebhookService) cleanupLoop() {
	ticker := time.NewTicker(WebhookCleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ws.stopCh:
			return
		case <-ticker.C:
			deleted := ws.CleanupOldDeliveries(WebhookMaxAge)
			if deleted > 0 {
				ws.logger.Info("cleaned up old webhook deliveries", "count", deleted)
			}
		}
	}
}

// TriggerWebhook sends a webhook notification asynchronously
func (ws *WebhookService) TriggerWebhook(webhookURL string, job *Job, duration time.Duration) {
	if webhookURL == "" {
		return
	}

	// Parse URL first to check scheme
	parsedURL, err := url.Parse(webhookURL)
	if err != nil {
		ws.logger.Warn("invalid webhook URL, skipping delivery",
			"job_id", job.ID,
			"url", webhookURL,
			"error", err)
		return
	}

	// Check HTTPS requirement
	if ws.config.RequireHTTPS && parsedURL.Scheme != "https" {
		ws.logger.Warn("webhook URL must use HTTPS (RequireHTTPS is enabled), skipping delivery",
			"job_id", job.ID,
			"url", webhookURL)
		return
	}

	// Validate URL for security (SSRF protection)
	if err := validateWebhookURL(webhookURL, ws.config.AllowPrivateIPs); err != nil {
		ws.logger.Warn("invalid webhook URL, skipping delivery",
			"job_id", job.ID,
			"url", webhookURL,
			"error", err)
		return
	}

	payload := WebhookPayload{
		JobID:      job.ID,
		JobType:    string(job.Type),
		Domain:     job.Domain,
		Status:     string(job.Status),
		Error:      job.Error,
		RetryCount: job.RetryCount,
		Timestamp:  time.Now(),
		Duration:   duration.String(),
		WebhookID:  fmt.Sprintf("wh-%s-%d", job.ID, time.Now().UnixNano()),
	}

	delivery := &WebhookDelivery{
		ID:         payload.WebhookID,
		WebhookURL: webhookURL,
		Payload:    payload,
		Status:     WebhookStatusPending,
		Attempts:   0,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}

	ws.mu.Lock()
	ws.deliveries[delivery.ID] = delivery
	ws.mu.Unlock()

	// Try to acquire semaphore without blocking job processing
	select {
	case ws.semaphore <- struct{}{}:
		// Acquired semaphore, deliver asynchronously
		go func() {
			defer func() {
				// Recover from panics and release semaphore
				if r := recover(); r != nil {
					ws.logger.Error("webhook delivery panic recovered", "webhook_id", delivery.ID, "panic", r)
				}
				<-ws.semaphore
			}()
			ws.deliver(delivery)
		}()
	default:
		// Semaphore full, log warning and skip webhook
		ws.logger.Warn("webhook delivery skipped: max concurrent webhooks reached",
			"job_id", job.ID,
			"webhook_id", delivery.ID,
			"max_concurrent", ws.config.MaxConcurrentWebhooks)

		// Update delivery status to failed
		ws.mu.Lock()
		delivery.Status = WebhookStatusFailed
		delivery.LastError = "webhook skipped: max concurrent limit reached"
		delivery.UpdatedAt = time.Now()
		ws.mu.Unlock()
	}
}

// deliver attempts to deliver a webhook with retries
func (ws *WebhookService) deliver(delivery *WebhookDelivery) {
	logger := ws.logger.With(
		"webhook_id", delivery.ID,
		"job_id", delivery.Payload.JobID,
		"url", delivery.WebhookURL,
	)

	logger.Info("starting webhook delivery")

	for attempt := 0; attempt <= ws.config.MaxRetries; attempt++ {
		if attempt > 0 {
			logger.Info("retrying webhook delivery",
				"attempt", attempt,
				"delay", ws.config.RetryDelay)
			time.Sleep(ws.config.RetryDelay)
		}

		err := ws.sendWebhook(delivery)

		// Update delivery state with mutex protection
		ws.mu.Lock()
		delivery.Attempts = attempt + 1
		delivery.UpdatedAt = time.Now()

		if err == nil {
			delivery.Status = WebhookStatusDelivered
			ws.mu.Unlock()
			logger.Info("webhook delivered successfully",
				"attempts", delivery.Attempts)
			return
		}

		delivery.LastError = err.Error()
		if attempt < ws.config.MaxRetries {
			delivery.Status = WebhookStatusFailed
		}
		ws.mu.Unlock()

		logger.Warn("webhook delivery failed",
			"attempt", attempt+1,
			"error", err)
	}

	ws.mu.Lock()
	delivery.Status = WebhookStatusMaxRetriesExceeded
	delivery.UpdatedAt = time.Now()
	ws.mu.Unlock()

	logger.Error("webhook delivery failed after max retries",
		"max_retries", ws.config.MaxRetries,
		"last_error", delivery.LastError)
}

// GetDelivery retrieves a webhook delivery by ID
func (ws *WebhookService) GetDelivery(id string) (*WebhookDelivery, bool) {
	ws.mu.RLock()
	defer ws.mu.RUnlock()
	delivery, ok := ws.deliveries[id]
	return delivery, ok
}

// GetDeliveriesByJob returns all webhook deliveries for a job
func (ws *WebhookService) GetDeliveriesByJob(jobID string) []*WebhookDelivery {
	ws.mu.RLock()
	defer ws.mu.RUnlock()

	var result []*WebhookDelivery
	for _, delivery := range ws.deliveries {
		if delivery.Payload.JobID == jobID {
			result = append(result, delivery)
		}
	}
	return result
}

// CleanupOldDeliveries removes deliveries older than the specified duration
func (ws *WebhookService) CleanupOldDeliveries(olderThan time.Duration) int {
	ws.mu.Lock()
	defer ws.mu.Unlock()

	cutoff := time.Now().Add(-olderThan)
	deleted := 0

	for id, delivery := range ws.deliveries {
		if delivery.CreatedAt.Before(cutoff) {
			delete(ws.deliveries, id)
			deleted++
		}
	}

	return deleted
}

// GetStats returns statistics about webhook deliveries
func (ws *WebhookService) GetStats() map[string]interface{} {
	ws.mu.RLock()
	defer ws.mu.RUnlock()

	stats := map[string]interface{}{
		"total_deliveries": len(ws.deliveries),
		"pending":          0,
		"delivered":        0,
		"failed":           0,
		"max_retries":      0,
	}

	for _, delivery := range ws.deliveries {
		switch delivery.Status {
		case WebhookStatusPending:
			stats["pending"] = stats["pending"].(int) + 1
		case WebhookStatusDelivered:
			stats["delivered"] = stats["delivered"].(int) + 1
		case WebhookStatusFailed:
			stats["failed"] = stats["failed"].(int) + 1
		case WebhookStatusMaxRetriesExceeded:
			stats["max_retries"] = stats["max_retries"].(int) + 1
		}
	}

	return stats
}
