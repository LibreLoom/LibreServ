package jobqueue

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// errWebhookRedirect refuses HTTP redirects. A public URL that 302s to a
// private or metadata address would otherwise bypass validateWebhookURL.
var errWebhookRedirect = fmt.Errorf("webhook redirects are not followed (SSRF protection)")

// NewWebhookService builds a WebhookService with a client that never follows
// redirects (re-validation gap closed; see luna-connect health probes #292).
func NewWebhookService(cfg WebhookConfig, logger *slog.Logger) *WebhookService {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	if cfg.MaxConcurrentWebhooks <= 0 {
		cfg.MaxConcurrentWebhooks = 10
	}
	if logger == nil {
		logger = slog.Default().With("component", "webhook_service")
	}
	return &WebhookService{
		config: cfg,
		client: &http.Client{
			Timeout: cfg.Timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return errWebhookRedirect
			},
		},
		logger:     logger,
		deliveries: make(map[string]*WebhookDelivery),
		stopCh:     make(chan struct{}),
		semaphore:  make(chan struct{}, cfg.MaxConcurrentWebhooks),
	}
}

// sendWebhook sends a single webhook HTTP request.
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
