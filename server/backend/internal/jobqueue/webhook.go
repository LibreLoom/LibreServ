package jobqueue

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
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

// DefaultWebhookConfig returns sensible defaults for webhook delivery
func DefaultWebhookConfig() WebhookConfig {
	return WebhookConfig{
		Timeout:               30 * time.Second,
		MaxRetries:            3,
		RetryDelay:            1 * time.Minute,
		AllowPrivateIPs:       true,  // Allow private IPs by default for development
		RequireHTTPS:          false, // Allow HTTP by default for development
		MaxConcurrentWebhooks: 100,   // Limit concurrent webhook deliveries to prevent OOM
	}
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

// NewWebhookService creates a new webhook service
func NewWebhookService(cfg WebhookConfig) *WebhookService {
	// Use default if not set
	maxConcurrent := cfg.MaxConcurrentWebhooks
	if maxConcurrent <= 0 {
		maxConcurrent = 100
	}

	return &WebhookService{
		config: cfg,
		client: &http.Client{
			Timeout: cfg.Timeout,
		},
		logger:     slog.Default().With("component", "webhook_service"),
		deliveries: make(map[string]*WebhookDelivery),
		stopCh:     make(chan struct{}),
		semaphore:  make(chan struct{}, maxConcurrent),
	}
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

// Stop halts the webhook service and cleanup goroutine
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

// isPrivateIP checks if an IP address is in a private range
func isPrivateIP(ip string) bool {
	// Check for localhost variants
	if ip == "localhost" || ip == "127.0.0.1" || ip == "::1" || ip == "0:0:0:0:0:0:0:1" {
		return true
	}

	// Parse the IP
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		// Not a valid IP, might be a hostname
		return false
	}

	// Check private ranges
	privateRanges := []string{
		"10.0.0.0/8",     // RFC1918
		"172.16.0.0/12",  // RFC1918
		"192.168.0.0/16", // RFC1918
		"127.0.0.0/8",    // Loopback
		"169.254.0.0/16", // Link-local
		"::1/128",        // IPv6 loopback
		"fe80::/10",      // IPv6 link-local
		"fc00::/7",       // IPv6 unique local
	}

	for _, cidr := range privateRanges {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if ipNet.Contains(parsedIP) {
			return true
		}
	}

	return false
}

// validateWebhookURL validates and sanitizes a webhook URL for security
// It resolves hostnames to IPs immediately to prevent DNS rebinding attacks
func validateWebhookURL(webhookURL string, allowPrivate bool) error {
	if webhookURL == "" {
		return fmt.Errorf("webhook URL is empty")
	}

	parsedURL, err := url.Parse(webhookURL)
	if err != nil {
		return fmt.Errorf("invalid webhook URL: %w", err)
	}

	// Only allow HTTP and HTTPS schemes
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return fmt.Errorf("webhook URL must use http or https scheme, got: %s", parsedURL.Scheme)
	}

	// SSRF Protection: Resolve hostname and check IPs
	host := parsedURL.Hostname()

	// Check for metadata endpoints by name (before DNS resolution)
	metadataHostnames := []string{
		"169.254.169.254",
		"169.254.170.2",
		"169.254.169.253",
		"metadata.google.internal",
		"instance-data",
		"metadata",
	}
	for _, endpoint := range metadataHostnames {
		if host == endpoint {
			return fmt.Errorf("webhook URL cannot target cloud metadata endpoints")
		}
	}

	// Resolve hostname to IP(s) immediately to prevent DNS rebinding
	// This ensures we validate the actual IP, not just the hostname
	ips, err := net.LookupIP(host)
	if err != nil {
		// If we can't resolve, check if it's already an IP
		ip := net.ParseIP(host)
		if ip == nil {
			return fmt.Errorf("failed to resolve webhook URL hostname: %w", err)
		}
		ips = []net.IP{ip}
	}

	// Check all resolved IPs
	for _, ip := range ips {
		ipStr := ip.String()

		// Check for metadata endpoints
		for _, endpoint := range metadataHostnames {
			if ipStr == endpoint {
				return fmt.Errorf("webhook URL resolves to cloud metadata endpoint: %s", ipStr)
			}
		}

		// Check for private IPs
		if isPrivateIP(ipStr) && !allowPrivate {
			return fmt.Errorf("webhook URL resolves to private IP address: %s (SSRF protection)", ipStr)
		}
	}

	return nil
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

// sendWebhook sends a single webhook HTTP request
func (ws *WebhookService) sendWebhook(delivery *WebhookDelivery) error {
	payloadBytes, err := json.Marshal(delivery.Payload)
	if err != nil {
		return fmt.Errorf("marshal webhook payload: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), ws.config.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, delivery.WebhookURL, bytes.NewBuffer(payloadBytes))
	if err != nil {
		return fmt.Errorf("create webhook request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "LibreServ-Webhook/1.0")

	resp, err := ws.client.Do(req)
	if err != nil {
		return fmt.Errorf("send webhook request: %w", err)
	}
	defer resp.Body.Close()

	// Drain the response body to allow connection reuse
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned non-success status: %d", resp.StatusCode)
	}

	return nil
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
