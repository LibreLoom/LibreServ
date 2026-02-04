package jobqueue

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWebhookService_TriggerWebhook_Success(t *testing.T) {
	// Create a test server that accepts webhooks
	received := make(chan WebhookPayload, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected Content-Type: application/json, got %s", r.Header.Get("Content-Type"))
		}

		var payload WebhookPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("failed to decode payload: %v", err)
		}
		received <- payload
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// Create webhook service
	ws := NewWebhookService(DefaultWebhookConfig())

	// Create a test job
	job := &Job{
		ID:         "test-job-1",
		Type:       JobTypeIssuance,
		Domain:     "example.com",
		Email:      "test@example.com",
		Status:     JobStatusSucceeded,
		RetryCount: 0,
		WebhookURL: server.URL,
	}

	// Trigger webhook
	ws.TriggerWebhook(server.URL, job, 5*time.Second)

	// Wait for delivery
	select {
	case payload := <-received:
		if payload.JobID != job.ID {
			t.Errorf("expected job_id %s, got %s", job.ID, payload.JobID)
		}
		if payload.Domain != job.Domain {
			t.Errorf("expected domain %s, got %s", job.Domain, payload.Domain)
		}
		if payload.Status != string(job.Status) {
			t.Errorf("expected status %s, got %s", job.Status, payload.Status)
		}
		if payload.Duration != "5s" {
			t.Errorf("expected duration 5s, got %s", payload.Duration)
		}
	case <-time.After(2 * time.Second):
		t.Error("timeout waiting for webhook")
	}

	// Wait for async delivery to complete
	time.Sleep(100 * time.Millisecond)

	// Check delivery status
	deliveries := ws.GetDeliveriesByJob(job.ID)
	if len(deliveries) != 1 {
		t.Errorf("expected 1 delivery, got %d", len(deliveries))
	}
	if deliveries[0].Status != WebhookStatusDelivered {
		t.Errorf("expected status Delivered, got %v", deliveries[0].Status)
	}
}

func TestWebhookService_TriggerWebhook_NoURL(t *testing.T) {
	ws := NewWebhookService(DefaultWebhookConfig())

	job := &Job{
		ID:         "test-job-2",
		Type:       JobTypeIssuance,
		Domain:     "example.com",
		Status:     JobStatusSucceeded,
		WebhookURL: "", // No webhook URL
	}

	// Should not panic or error
	ws.TriggerWebhook("", job, 5*time.Second)

	// Verify no deliveries were created
	deliveries := ws.GetDeliveriesByJob(job.ID)
	if len(deliveries) != 0 {
		t.Errorf("expected 0 deliveries, got %d", len(deliveries))
	}
}

func TestWebhookService_GetStats(t *testing.T) {
	ws := NewWebhookService(DefaultWebhookConfig())

	// Create test deliveries with different statuses
	ws.deliveries["test-1"] = &WebhookDelivery{
		ID:     "test-1",
		Status: WebhookStatusPending,
	}
	ws.deliveries["test-2"] = &WebhookDelivery{
		ID:     "test-2",
		Status: WebhookStatusDelivered,
	}
	ws.deliveries["test-3"] = &WebhookDelivery{
		ID:     "test-3",
		Status: WebhookStatusFailed,
	}
	ws.deliveries["test-4"] = &WebhookDelivery{
		ID:     "test-4",
		Status: WebhookStatusMaxRetriesExceeded,
	}

	stats := ws.GetStats()

	if stats["total_deliveries"] != 4 {
		t.Errorf("expected total_deliveries 4, got %v", stats["total_deliveries"])
	}
	if stats["pending"] != 1 {
		t.Errorf("expected pending 1, got %v", stats["pending"])
	}
	if stats["delivered"] != 1 {
		t.Errorf("expected delivered 1, got %v", stats["delivered"])
	}
	if stats["failed"] != 1 {
		t.Errorf("expected failed 1, got %v", stats["failed"])
	}
	if stats["max_retries"] != 1 {
		t.Errorf("expected max_retries 1, got %v", stats["max_retries"])
	}
}

func TestWebhookService_CleanupOldDeliveries(t *testing.T) {
	ws := NewWebhookService(DefaultWebhookConfig())

	// Create old delivery
	ws.deliveries["old"] = &WebhookDelivery{
		ID:        "old",
		CreatedAt: time.Now().Add(-48 * time.Hour),
	}
	// Create recent delivery
	ws.deliveries["recent"] = &WebhookDelivery{
		ID:        "recent",
		CreatedAt: time.Now().Add(-1 * time.Hour),
	}

	deleted := ws.CleanupOldDeliveries(24 * time.Hour)

	if deleted != 1 {
		t.Errorf("expected 1 deletion, got %d", deleted)
	}

	if _, ok := ws.deliveries["old"]; ok {
		t.Error("old delivery should have been deleted")
	}
	if _, ok := ws.deliveries["recent"]; !ok {
		t.Error("recent delivery should still exist")
	}
}

func TestDefaultWebhookConfig(t *testing.T) {
	cfg := DefaultWebhookConfig()

	if cfg.Timeout != DefaultWebhookTimeout {
		t.Errorf("expected timeout %v, got %v", DefaultWebhookTimeout, cfg.Timeout)
	}
	if cfg.MaxRetries != DefaultWebhookMaxRetries {
		t.Errorf("expected max_retries %d, got %d", DefaultWebhookMaxRetries, cfg.MaxRetries)
	}
	if cfg.RetryDelay != DefaultWebhookRetryDelay {
		t.Errorf("expected retry_delay %v, got %v", DefaultWebhookRetryDelay, cfg.RetryDelay)
	}
}
