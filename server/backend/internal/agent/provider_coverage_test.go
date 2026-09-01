package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
)

type providerCoverageConnectClient struct {
	status       *connect.ConnectStatus
	statusErr    error
	provisioned  *connect.ProvisionedCredentials
	provisionErr error
}

func (c *providerCoverageConnectClient) Activate(context.Context, string) (*connect.ConnectStatus, error) {
	return c.status, c.statusErr
}
func (c *providerCoverageConnectClient) Deactivate(context.Context) error { return nil }
func (c *providerCoverageConnectClient) Provision(context.Context, connect.ServiceID) (*connect.ProvisionedCredentials, error) {
	return c.provisioned, c.provisionErr
}
func (c *providerCoverageConnectClient) RegisterRoute(context.Context, string) error   { return nil }
func (c *providerCoverageConnectClient) UnregisterRoute(context.Context, string) error { return nil }
func (c *providerCoverageConnectClient) DeleteTunnel(context.Context) error            { return nil }
func (c *providerCoverageConnectClient) Status(context.Context) (*connect.ConnectStatus, error) {
	return c.status, c.statusErr
}
func (c *providerCoverageConnectClient) Usage(context.Context) (*connect.UsageSummary, error) {
	return nil, nil
}
func (c *providerCoverageConnectClient) Info(context.Context) (*connect.ConnectInfo, error) {
	return nil, nil
}
func (c *providerCoverageConnectClient) VerifyProbe(context.Context, string, int, string) (*connect.VerifyProbeResult, error) {
	return nil, nil
}
func (c *providerCoverageConnectClient) ConnectKey() string { return "coverage-key" }

type providerCoverageRoundTripper func(*http.Request) (*http.Response, error)

func (f providerCoverageRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func withProviderCoverageConfig(t *testing.T, cfg *config.Config) {
	t.Helper()
	previous := config.Get()
	config.SetTestConfig(cfg)
	t.Cleanup(func() { config.SetTestConfig(previous) })
}

func connectedAIStatus() *connect.ConnectStatus {
	return &connect.ConnectStatus{
		Connected: true,
		Services: map[connect.ServiceID]connect.ServiceStatus{
			connect.ServiceAI: {State: connect.ServiceConnected},
		},
	}
}

func TestProviderConfigurationAndConnectPaths(t *testing.T) {
	previous := config.Get()
	config.SetTestConfig(nil)
	if AIConfigured(nil, nil) || NewAIProvider(context.Background(), nil, nil) != nil || calculateCost("model", 1, 1, 1) != 0 {
		t.Fatal("nil configuration unexpectedly enabled AI")
	}

	cfg := &config.Config{Support: config.SupportConfig{
		InferenceBaseURL: "https://inference.example/v1",
		Pricing: map[string]config.ModelPricing{
			"priced": {InputPer1M: 1, OutputPer1M: 2, CachePer1M: 0.5},
		},
	}}
	config.SetTestConfig(cfg)
	t.Cleanup(func() { config.SetTestConfig(previous) })

	if newBYOKProvider(cfg) != nil {
		t.Fatal("BYOK provider created without an API key")
	}
	if AIConfigured(nil, nil) {
		t.Fatal("AI configured without BYOK or Connect")
	}

	cfg.Support.BYOKEnabled = true
	cfg.Support.UserAPIKey = "user-key"
	cfg.Support.UserAPIFormat = "anthropic"
	if !AIConfigured(nil, nil) {
		t.Fatal("BYOK configuration was not detected")
	}
	p := NewAIProvider(context.Background(), nil, nil)
	if p == nil || p.BaseURL != cfg.Support.InferenceBaseURL || p.APIFormat != "anthropic" {
		t.Fatalf("unexpected BYOK provider: %+v", p)
	}
	cfg.Support.UserBaseURL = "https://byok.example/v1/"
	if p = newBYOKProvider(cfg); p.BaseURL != "https://byok.example/v1" {
		t.Fatalf("BYOK base URL = %q", p.BaseURL)
	}
	if got := calculateCost("priced", 1_000_000, 500_000, 2_000_000); got != 3 {
		t.Fatalf("calculated cost = %v", got)
	}
	if calculateCost("missing", 100, 100, 100) != 0 {
		t.Fatal("missing pricing produced a cost")
	}

	cfg.Support.BYOKEnabled = false
	cfg.Support.UserBaseURL = ""
	client := &providerCoverageConnectClient{status: connectedAIStatus()}
	if !AIConfigured(client, nil) {
		t.Fatal("connected AI service was not detected")
	}
	p = NewAIProvider(context.Background(), client, nil)
	if p == nil || p.BaseURL != cfg.Support.InferenceBaseURL || p.APIFormat != "anthropic" {
		t.Fatalf("persisted Connect provider = %+v", p)
	}
	cfg.Support.UserAPIFormat = ""
	if p = NewAIProvider(context.Background(), client, nil); p == nil || p.APIFormat != "openai" {
		t.Fatalf("default persisted format = %+v", p)
	}

	cfg.Support.UserAPIKey = ""
	client.provisioned = &connect.ProvisionedCredentials{AI: &connect.AICredentials{
		BaseURL: "https://provisioned.example/v1/",
		APIKey:  "provisioned-key",
	}}
	p = NewAIProvider(context.Background(), client, nil)
	if p == nil || p.BaseURL != "https://provisioned.example/v1" || p.APIKey != "provisioned-key" {
		t.Fatalf("live provision provider = %+v", p)
	}

	for _, tc := range []struct {
		name   string
		client connect.Client
	}{
		{"nil client", nil},
		{"status error", &providerCoverageConnectClient{statusErr: errors.New("offline")}},
		{"nil status", &providerCoverageConnectClient{}},
		{"disconnected", &providerCoverageConnectClient{status: &connect.ConnectStatus{}}},
		{"missing service", &providerCoverageConnectClient{status: &connect.ConnectStatus{Connected: true, Services: map[connect.ServiceID]connect.ServiceStatus{}}}},
		{"disabled service", &providerCoverageConnectClient{status: &connect.ConnectStatus{Connected: true, Services: map[connect.ServiceID]connect.ServiceStatus{
			connect.ServiceAI: {State: connect.ServiceDisabled},
		}}}},
		{"provision error", &providerCoverageConnectClient{status: connectedAIStatus(), provisionErr: errors.New("failed")}},
		{"nil credentials", &providerCoverageConnectClient{status: connectedAIStatus()}},
		{"nil AI credentials", &providerCoverageConnectClient{status: connectedAIStatus(), provisioned: &connect.ProvisionedCredentials{}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := NewAIProvider(context.Background(), tc.client, nil); got != nil {
				t.Fatalf("provider = %+v", got)
			}
		})
	}
}

func TestOpenAIProviderProtocol(t *testing.T) {
	withProviderCoverageConfig(t, &config.Config{Support: config.SupportConfig{
		Pricing: map[string]config.ModelPricing{
			"model": {InputPer1M: 1, OutputPer1M: 2, CachePer1M: 3},
		},
	}})

	var chatRequests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer api-key" {
			t.Errorf("authorization header = %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/v1/models":
			_, _ = io.WriteString(w, `{"data":[{"id":"model","object":"model","created":42,"owned_by":"test"}]}`)
		case "/v1/chat/completions":
			chatRequests++
			var body chatRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			if body.Model != "model" || len(body.Messages) == 0 {
				t.Errorf("unexpected chat request: %+v", body)
			}
			if body.Stream {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "event: message\ndata: {\"delta\":\"one\"}\n\ndata: {\"delta\":\"two\"}\n\ndata: [DONE]\n\n")
				return
			}
			_, _ = io.WriteString(w, `{
				"choices":[{"message":{"content":"hello","tool_calls":[
					{"id":"one","function":{"name":"bash","arguments":""}},
					{"id":"two","function":{"name":"read","arguments":"{\"path\":\"/tmp\"}"}}
				]}}],
				"usage":{"prompt_tokens":3,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":5}}
			}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL+"/v1/", "api-key")
	if provider.modelsURL() != server.URL+"/v1/models" || provider.chatCompletionsURL() != server.URL+"/v1/chat/completions" {
		t.Fatalf("unexpected provider URLs: %q %q", provider.modelsURL(), provider.chatCompletionsURL())
	}
	messages := []Message{
		{Role: RoleUser, Content: "hello"},
		{Role: RoleAssistant, Content: "checking", ToolCalls: []ToolCallMessage{{ID: "prior", Name: "bash", Arguments: json.RawMessage(`{"command":"true"}`)}}},
		{Role: RoleTool, ToolCallID: "prior", Content: "ok"},
	}
	response, usage, err := provider.Chat(context.Background(), "model", messages, []map[string]interface{}{{"type": "function"}})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if response.Content != "hello" || len(response.ToolCalls) != 2 || string(response.ToolCalls[0].Arguments) != "{}" {
		t.Fatalf("chat response = %+v", response)
	}
	if usage.InputTokens != 0 || usage.OutputTokens != 4 || usage.CacheTokens != 5 || math.Abs(usage.CostUSD-0.000023) > 1e-12 {
		t.Fatalf("usage = %+v", usage)
	}

	agent := NewAgent("coverage", "model", "", "", "system prompt", provider)
	if _, _, err := agent.Call(context.Background(), messages, nil); err != nil {
		t.Fatalf("agent provider call: %v", err)
	}
	if chatRequests != 2 {
		t.Fatalf("chat request count = %d", chatRequests)
	}

	models, err := provider.Models(context.Background())
	if err != nil || len(models) != 1 || models[0].ID != "model" {
		t.Fatalf("Models = %+v, %v", models, err)
	}

	stream, err := provider.ChatStream(context.Background(), "model", messages)
	if err != nil {
		t.Fatalf("ChatStream: %v", err)
	}
	var chunks []SSEChunk
	for chunk := range stream {
		chunks = append(chunks, chunk)
	}
	if len(chunks) != 2 || chunks[0].Event != "message" || !strings.Contains(chunks[1].Data, "two") {
		t.Fatalf("stream chunks = %+v", chunks)
	}

	eventJSON, err := json.Marshal(Event{Type: EventUsageUpdate, Data: UsageUpdateData{InputTokens: 2}})
	if err != nil || !strings.Contains(string(eventJSON), `"usage_update"`) {
		t.Fatalf("event JSON = %s, %v", eventJSON, err)
	}
}

func TestOpenAIProviderAdditionalErrorPaths(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int
		body       string
		want       string
		wantModels string
	}{
		{"credit exhausted", http.StatusPaymentRequired, "limit", "monthly AI support credit", "API returned 402"},
		{"server error", http.StatusBadGateway, "upstream", "API returned 502", "API returned 502"},
		{"invalid JSON", http.StatusOK, "{", "decode response", "decode response"},
		{"no choices", http.StatusOK, `{"choices":[]}`, "no response choices", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			t.Cleanup(server.Close)
			provider := NewProvider(server.URL, "key")
			if _, _, err := provider.Chat(context.Background(), "model", nil, nil); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Chat error = %v", err)
			}
			if tc.wantModels != "" {
				if _, err := provider.Models(context.Background()); err == nil || !strings.Contains(err.Error(), tc.wantModels) {
					t.Fatalf("Models error = %v", err)
				}
			}
			if tc.status != http.StatusOK {
				if _, err := provider.ChatStream(context.Background(), "model", nil); err == nil {
					t.Fatal("ChatStream accepted an error response")
				}
			}
		})
	}

	requestFailure := errors.New("transport failed")
	provider := NewProvider("http://provider.invalid", "key")
	provider.HTTPClient = &http.Client{Transport: providerCoverageRoundTripper(func(*http.Request) (*http.Response, error) {
		return nil, requestFailure
	})}
	if _, _, err := provider.Chat(context.Background(), "model", nil, nil); !errors.Is(err, requestFailure) {
		t.Fatalf("Chat transport error = %v", err)
	}
	if _, err := provider.Models(context.Background()); !errors.Is(err, requestFailure) {
		t.Fatalf("Models transport error = %v", err)
	}
	if _, err := provider.ChatStream(context.Background(), "model", nil); !errors.Is(err, requestFailure) {
		t.Fatalf("ChatStream transport error = %v", err)
	}

	invalidURL := NewProvider(":", "key")
	for name, call := range map[string]func() error{
		"chat": func() error {
			_, _, err := invalidURL.Chat(context.Background(), "model", nil, nil)
			return err
		},
		"models": func() error {
			_, err := invalidURL.Models(context.Background())
			return err
		},
		"stream": func() error {
			_, err := invalidURL.ChatStream(context.Background(), "model", nil)
			return err
		},
	} {
		if err := call(); err == nil {
			t.Errorf("%s accepted invalid URL", name)
		}
	}

	ch := make(chan SSEChunk, 1)
	NewProvider("", "").parseSSE(strings.NewReader("data: "+strings.Repeat("x", 1024*1024+1)), ch)
	close(ch)
	chunk := <-ch
	if chunk.Err == nil || !strings.Contains(chunk.Err.Error(), "stream ended before completion") {
		t.Fatalf("oversized SSE error = %v", chunk.Err)
	}
}

func TestAnthropicProviderProtocol(t *testing.T) {
	withProviderCoverageConfig(t, &config.Config{Support: config.SupportConfig{Pricing: map[string]config.ModelPricing{
		"claude": {InputPer1M: 1, OutputPer1M: 2},
	}}})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "anthropic-key" || r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Errorf("anthropic headers = %#v", r.Header)
		}
		switch r.URL.Path {
		case "/models":
			_, _ = io.WriteString(w, `{"data":[{"id":"claude"}]}`)
		case "/messages":
			var body anthropicRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode anthropic request: %v", err)
				return
			}
			if body.System != "first\n\nsecond" || len(body.Messages) != 3 {
				t.Errorf("unexpected anthropic messages: %+v", body)
			}
			if body.Stream {
				_, _ = io.WriteString(w, "event: content_block_delta\ndata: {\"text\":\"hello\"}\n\ndata: [DONE]\n\n")
				return
			}
			if len(body.Tools) != 3 {
				t.Errorf("anthropic tools = %+v", body.Tools)
			}
			_, _ = io.WriteString(w, `{"content":[
				{"type":"text","text":"hello "},
				{"type":"text","text":"world"},
				{"type":"tool_use","id":"tool-1","name":"bash","input":{"command":"true"}}
			],"usage":{"input_tokens":10,"output_tokens":5}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL, "anthropic-key")
	provider.APIFormat = "anthropic"
	messages := []Message{
		{Role: RoleSystem, Content: "first"},
		{Role: RoleSystem, Content: "second"},
		{Role: RoleUser, Content: "one"},
		{Role: RoleUser, Content: "two"},
		{Role: RoleAssistant, Content: "working", ToolCalls: []ToolCallMessage{
			{ID: "good", Name: "bash", Arguments: json.RawMessage(`{"command":"true"}`)},
			{ID: "bad", Name: "read", Arguments: json.RawMessage(`{`)},
		}},
		{Role: RoleTool, ToolCallID: "good", Content: "ok"},
	}
	tools := []map[string]interface{}{
		{"type": "ignored"},
		{"function": "wrong"},
		{"function": map[string]interface{}{"name": ""}},
		{"function": map[string]interface{}{"name": "bash", "description": "run", "parameters": map[string]interface{}{"type": "object"}}},
		{"function": map[string]interface{}{"name": "read", "parameters": json.RawMessage(`{"type":"object"}`)}},
		{"function": map[string]interface{}{"name": "bad-schema", "parameters": json.RawMessage(`{`)}},
	}
	response, usage, err := provider.Chat(context.Background(), "claude", messages, tools)
	if err != nil {
		t.Fatalf("anthropic Chat: %v", err)
	}
	if response.Content != "hello world" || len(response.ToolCalls) != 1 || usage.InputTokens != 10 || usage.CostUSD != 0.00002 {
		t.Fatalf("anthropic result = %+v usage=%+v", response, usage)
	}
	models, err := provider.Models(context.Background())
	if err != nil || len(models) != 1 || models[0].ID != "claude" {
		t.Fatalf("anthropic Models = %+v, %v", models, err)
	}
	stream, err := provider.ChatStream(context.Background(), "claude", messages)
	if err != nil {
		t.Fatalf("anthropic ChatStream: %v", err)
	}
	chunk := <-stream
	if chunk.Event != "content_block_delta" || !strings.Contains(chunk.Data, "hello") {
		t.Fatalf("anthropic stream chunk = %+v", chunk)
	}
}

func TestAnthropicProviderErrorsAndReview(t *testing.T) {
	responses := map[string]string{
		"allow":   `{"verdict":"allow","reason":"safe"}`,
		"review":  `{"verdict":"review","reason":"confirm"}`,
		"empty":   "",
		"bad":     "not-json",
		"invalid": `{"verdict":"maybe","reason":"unknown"}`,
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			http.Error(w, "no models", http.StatusBadGateway)
			return
		}
		var body anthropicRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		content := ""
		if len(body.Messages) > 0 && len(body.Messages[len(body.Messages)-1].Content) > 0 {
			content = body.Messages[len(body.Messages)-1].Content[0].Text
		}
		for key, value := range responses {
			if strings.Contains(content, "Tool: "+key) {
				_, _ = io.WriteString(w, `{"content":[{"type":"text","text":`+strconvQuote(value)+`}],"usage":{}}`)
				return
			}
		}
		http.Error(w, "failed", http.StatusBadGateway)
	}))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL, "key")
	provider.APIFormat = "anthropic"
	reviewer := NewReviewModel(provider, "claude")
	for _, tc := range []struct {
		tool     string
		auto     bool
		expected ReviewVerdict
	}{
		{"allow", false, ReviewAllow},
		{"review", false, ReviewReview},
		{"review", true, ReviewDeny},
		{"empty", false, ReviewReview},
		{"empty", true, ReviewDeny},
		{"bad", false, ReviewReview},
		{"invalid", true, ReviewDeny},
		{"server-error", false, ReviewReview},
		{"server-error", true, ReviewDeny},
	} {
		result, err := reviewer.Review(context.Background(), "request", tc.tool, json.RawMessage(`{}`), "context", tc.auto)
		if err != nil || result.Verdict != tc.expected {
			t.Errorf("Review(%s, auto=%v) = %+v, %v", tc.tool, tc.auto, result, err)
		}
	}
	if !strings.Contains(buildReviewSystemPrompt(true), "autonomous") || strings.Contains(buildReviewSystemPrompt(false), "OPERATING MODE") {
		t.Fatal("review system prompts do not reflect operating mode")
	}

	if _, err := provider.Models(context.Background()); err == nil {
		t.Fatal("anthropic Models accepted error response")
	}
	if _, err := provider.ChatStream(context.Background(), "claude", nil); err == nil {
		t.Fatal("anthropic ChatStream accepted error response")
	}

	invalidJSON := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "{")
	}))
	t.Cleanup(invalidJSON.Close)
	bad := NewProvider(invalidJSON.URL, "key")
	bad.APIFormat = "anthropic"
	if _, _, err := bad.Chat(context.Background(), "claude", nil, nil); err == nil {
		t.Fatal("anthropic Chat decoded invalid JSON")
	}
	if _, err := bad.Models(context.Background()); err == nil {
		t.Fatal("anthropic Models decoded invalid JSON")
	}

	requestFailure := errors.New("anthropic transport failed")
	failing := NewProvider("http://provider.invalid", "key")
	failing.APIFormat = "anthropic"
	failing.HTTPClient = &http.Client{Transport: providerCoverageRoundTripper(func(*http.Request) (*http.Response, error) {
		return nil, requestFailure
	})}
	if _, _, err := failing.Chat(context.Background(), "claude", nil, nil); !errors.Is(err, requestFailure) {
		t.Fatalf("anthropic Chat transport error = %v", err)
	}
	if _, err := failing.Models(context.Background()); !errors.Is(err, requestFailure) {
		t.Fatalf("anthropic Models transport error = %v", err)
	}
	if _, err := failing.ChatStream(context.Background(), "claude", nil); !errors.Is(err, requestFailure) {
		t.Fatalf("anthropic ChatStream transport error = %v", err)
	}

	invalidURL := NewProvider(":", "key")
	invalidURL.APIFormat = "anthropic"
	if _, _, err := invalidURL.Chat(context.Background(), "claude", nil, nil); err == nil {
		t.Fatal("anthropic Chat accepted invalid URL")
	}
	if _, err := invalidURL.Models(context.Background()); err == nil {
		t.Fatal("anthropic Models accepted invalid URL")
	}
	if _, err := invalidURL.ChatStream(context.Background(), "claude", nil); err == nil {
		t.Fatal("anthropic ChatStream accepted invalid URL")
	}
}

func TestListModelsAndSelfHealingHelpers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"data":null}`)
	}))
	t.Cleanup(server.Close)
	withProviderCoverageConfig(t, &config.Config{Support: config.SupportConfig{
		BYOKEnabled: true,
		UserAPIKey:  "key",
		UserBaseURL: server.URL,
	}})

	models, err := ListAIModels(context.Background(), nil, nil)
	if err != nil || models == nil || len(models) != 0 {
		t.Fatalf("ListAIModels nil data = %#v, %v", models, err)
	}
	config.Get().Support.UserAPIKey = ""
	models, err = ListAIModels(context.Background(), nil, nil)
	if err != nil || models == nil || len(models) != 0 {
		t.Fatalf("ListAIModels no provider = %#v, %v", models, err)
	}

	config.Get().Support.SelfHealing = false
	monitor := NewSelfHealingMonitor(nil, nil, nil, nil)
	monitor.Start()
	monitor.checkAndHeal()
	monitor.healContainer(context.Background(), "container", config.Get())
	if prompt := buildSelfHealingPrompt(); !strings.Contains(prompt, "Self-Healing Agent") {
		t.Fatalf("self-healing prompt = %q", prompt)
	}

	config.Get().Support.SelfHealing = true
	config.Get().Support.Agent.MainModel = ""
	running := NewSelfHealingMonitor(nil, nil, nil, nil)
	running.interval = time.Hour
	running.Start()
	running.Stop()
}

func strconvQuote(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}
