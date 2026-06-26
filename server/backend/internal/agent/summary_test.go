package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionSummarizerAvailable(t *testing.T) {
	var nilProv *Provider
	if NewSessionSummarizer(nilProv, "m").Available() {
		t.Error("nil provider should be unavailable")
	}
	if NewSessionSummarizer(&Provider{}, "").Available() {
		t.Error("empty model should be unavailable")
	}
	if !NewSessionSummarizer(&Provider{}, "summary-model").Available() {
		t.Error("provider + model should be available")
	}
}

func TestBuildSummaryInput(t *testing.T) {
	msgs := []Message{
		{Role: RoleUser, Content: "fix my nextcloud"},
		{Role: RoleAssistant, Content: "Let me check the container.", ToolCalls: []ToolCallMessage{{ID: "tc1", Name: "bash", Arguments: json.RawMessage(`{"command":"podman ps"}`)}}},
		{Role: RoleTool, ToolCallID: "tc1", Content: "nextcloud is stopped"},
	}
	out := buildSummaryInput(msgs)
	for _, want := range []string{"fix my nextcloud", "podman ps", "nextcloud is stopped"} {
		if !strings.Contains(out, want) {
			t.Errorf("buildSummaryInput missing %q in: %q", want, out)
		}
	}
}

func TestSummarizeUnavailableReturnsEmpty(t *testing.T) {
	s := NewSessionSummarizer(nil, "")
	out, err := s.Summarize(context.Background(), []Message{{Role: RoleUser, Content: "hi"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "" {
		t.Errorf("unavailable summarizer should return empty, got %q", out)
	}
}

func TestSummarizeEmptyHistory(t *testing.T) {
	s := NewSessionSummarizer(&Provider{}, "summary-model")
	out, err := s.Summarize(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "No prior activity." {
		t.Errorf("empty history should yield No prior activity., got %q", out)
	}
}

// TestSummarizeLiveProvider proves the summarizer calls the provider and returns
// the model's summary text. It stands up a fake OpenAI-compatible endpoint.
func TestSummarizeLiveProvider(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify the summary model ID and system prompt are sent.
		var req struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Model != "summary-model" {
			t.Errorf("request model = %q, want summary-model", req.Model)
		}
		if len(req.Messages) < 2 || req.Messages[0].Role != "system" {
			t.Errorf("expected a system prompt first, got %+v", req.Messages)
		}
		if !strings.Contains(req.Messages[0].Content, "safety reviewer") {
			t.Errorf("system prompt does not mention the reviewer: %q", req.Messages[0].Content)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"User wants Nextcloud fixed; agent found it stopped."}}]}`))
	}))
	defer srv.Close()

	prov := NewProvider(srv.URL, "test-key")
	s := NewSessionSummarizer(prov, "summary-model")

	out, err := s.Summarize(context.Background(), []Message{
		{Role: RoleUser, Content: "fix my nextcloud"},
	})
	if err != nil {
		t.Fatalf("Summarize: %v", err)
	}
	if !strings.Contains(out, "Nextcloud") {
		t.Errorf("expected summary text, got %q", out)
	}
}
