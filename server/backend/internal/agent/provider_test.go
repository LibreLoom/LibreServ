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

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
)

func TestOpenAIProviderChatModelsAndStream(t *testing.T) {
	var sawAuthorization, sawTools, sawToolMessage bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer test-key" {
			sawAuthorization = true
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/models":
			_ = json.NewEncoder(w).Encode(ModelsResponse{Data: []ModelInfo{{ID: "model-a", Object: "model"}}})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/chat/completions":
			var request chatRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			sawTools = len(request.Tools) == 1
			for _, message := range request.Messages {
				if message.ToolCallID == "call-before" && len(message.ToolCalls) == 1 {
					sawToolMessage = true
				}
			}
			if request.Stream {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "event: message\n")
				_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n")
				_, _ = io.WriteString(w, "data: [DONE]\n\n")
				return
			}
			_, _ = io.WriteString(w, `{
				"id":"response-1",
				"choices":[{
					"message":{"role":"assistant","content":"done","tool_calls":[
						{"id":"call-1","type":"function","function":{"name":"status","arguments":"{\"all\":true}"}},
						{"id":"call-2","type":"function","function":{"name":"empty","arguments":""}}
					]},
					"finish_reason":"tool_calls"
				}],
				"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8,"prompt_tokens_details":{"cached_tokens":10}}
			}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	original := config.Get()
	config.SetTestConfig(&config.Config{Support: config.SupportConfig{
		Pricing: map[string]config.ModelPricing{
			"model-a": {InputPer1M: 1, OutputPer1M: 2, CachePer1M: 0.5},
		},
	}})
	t.Cleanup(func() { config.SetTestConfig(original) })

	provider := NewProvider(server.URL+"/v1/", "test-key")
	if provider.BaseURL != server.URL+"/v1" || provider.APIFormat != "openai" {
		t.Fatalf("unexpected provider defaults: %+v", provider)
	}
	messages := []Message{
		{Role: RoleSystem, Content: "system"},
		{
			Role: RoleAssistant, Content: "calling",
			ToolCalls: []ToolCallMessage{{ID: "call-1", Name: "status", Arguments: json.RawMessage(`{"all":true}`)}},
		},
		{Role: RoleTool, Content: "result", ToolCallID: "call-before"},
	}
	toolDefs := []map[string]interface{}{{
		"type":     "function",
		"function": map[string]interface{}{"name": "status"},
	}}
	response, usage, err := provider.Chat(context.Background(), "model-a", messages, toolDefs)
	if err != nil {
		t.Fatalf("OpenAI chat: %v", err)
	}
	if response.Content != "done" || len(response.ToolCalls) != 2 ||
		string(response.ToolCalls[0].Arguments) != `{"all":true}` ||
		string(response.ToolCalls[1].Arguments) != `{}` {
		t.Fatalf("unexpected OpenAI response: %+v", response)
	}
	if usage.InputTokens != 0 || usage.OutputTokens != 3 || usage.CacheTokens != 10 {
		t.Fatalf("unexpected usage: %+v", usage)
	}
	if math.Abs(usage.CostUSD-0.000011) > 0.0000001 {
		t.Fatalf("usage cost = %f", usage.CostUSD)
	}
	if !sawAuthorization || !sawTools || !sawToolMessage {
		t.Fatalf("request mapping missing: auth=%v tools=%v tool-message=%v", sawAuthorization, sawTools, sawToolMessage)
	}

	models, err := provider.Models(context.Background())
	if err != nil || len(models) != 1 || models[0].ID != "model-a" {
		t.Fatalf("OpenAI models: %#v, %v", models, err)
	}
	stream, err := provider.ChatStream(context.Background(), "model-a", messages)
	if err != nil {
		t.Fatalf("OpenAI stream: %v", err)
	}
	var chunks []SSEChunk
	for chunk := range stream {
		chunks = append(chunks, chunk)
	}
	if len(chunks) != 1 || chunks[0].Event != "message" || !strings.Contains(chunks[0].Data, "hello") {
		t.Fatalf("unexpected stream chunks: %#v", chunks)
	}
}

func TestOpenAIProviderErrorPaths(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"payment required", http.StatusPaymentRequired, "credit exhausted", "monthly AI support credit"},
		{"server error", http.StatusInternalServerError, "failed", "API returned 500"},
		{"invalid JSON", http.StatusOK, "{", "decode response"},
		{"no choices", http.StatusOK, `{"choices":[]}`, "no response choices"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			_, _, err := NewProvider(server.URL, "key").Chat(context.Background(), "model", nil, nil)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("chat error = %v, want %q", err, tc.want)
			}
		})
	}

	modelTests := []struct {
		name   string
		status int
		body   string
	}{
		{"status", http.StatusBadGateway, ""},
		{"decode", http.StatusOK, "{"},
	}
	for _, tc := range modelTests {
		t.Run("models "+tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			if _, err := NewProvider(server.URL, "key").Models(context.Background()); err == nil {
				t.Fatal("expected models error")
			}
		})
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no stream", http.StatusBadGateway)
	}))
	provider := NewProvider(server.URL, "key")
	if _, err := provider.ChatStream(context.Background(), "model", nil); err == nil {
		t.Fatal("expected stream status error")
	}
	server.Close()
	if _, _, err := provider.Chat(context.Background(), "model", nil, nil); err == nil {
		t.Fatal("expected request failure against closed server")
	}
	if _, err := provider.Models(context.Background()); err == nil {
		t.Fatal("expected model request failure against closed server")
	}
}

func TestAnthropicProviderChatModelsAndStream(t *testing.T) {
	var chatRequestBody anthropicRequest
	var sawAPIKey bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAPIKey = sawAPIKey || (r.Header.Get("x-api-key") == "anthropic-key" &&
			r.Header.Get("anthropic-version") == "2023-06-01")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/models":
			_ = json.NewEncoder(w).Encode(ModelsResponse{Data: []ModelInfo{{ID: "claude-test"}}})
		case r.Method == http.MethodPost && r.URL.Path == "/messages":
			if err := json.NewDecoder(r.Body).Decode(&chatRequestBody); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if chatRequestBody.Stream {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "event: content_block_delta\n")
				_, _ = io.WriteString(w, "data: {\"delta\":{\"text\":\"hello\"}}\n\n")
				_, _ = io.WriteString(w, "data: [DONE]\n\n")
				return
			}
			_, _ = io.WriteString(w, `{
				"id":"message-1","type":"message","role":"assistant",
				"content":[
					{"type":"text","text":"first "},
					{"type":"text","text":"second"},
					{"type":"tool_use","id":"tool-1","name":"status","input":{"all":true}}
				],
				"stop_reason":"tool_use",
				"usage":{"input_tokens":12,"output_tokens":4}
			}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL, "anthropic-key")
	provider.APIFormat = "anthropic"
	messages := []Message{
		{Role: RoleSystem, Content: "first system"},
		{Role: RoleSystem, Content: "second system"},
		{Role: RoleUser, Content: "first user"},
		{Role: RoleUser, Content: "second user"},
		{
			Role: RoleAssistant, Content: "assistant text",
			ToolCalls: []ToolCallMessage{
				{ID: "tool-1", Name: "status", Arguments: json.RawMessage(`{"all":true}`)},
				{ID: "tool-2", Name: "broken", Arguments: json.RawMessage(`{`)},
			},
		},
		{Role: RoleTool, ToolCallID: "tool-1", Content: "tool result"},
	}
	toolDefs := []map[string]interface{}{
		{"type": "invalid"},
		{"function": "invalid"},
		{"function": map[string]interface{}{"name": ""}},
		{"function": map[string]interface{}{
			"name": "status", "description": "Status", "parameters": map[string]interface{}{"type": "object"},
		}},
		{"function": map[string]interface{}{
			"name": "raw", "parameters": json.RawMessage(`{"type":"object"}`),
		}},
	}
	response, usage, err := provider.Chat(context.Background(), "claude-test", messages, toolDefs)
	if err != nil {
		t.Fatalf("Anthropic chat: %v", err)
	}
	if response.Content != "first second" || len(response.ToolCalls) != 1 ||
		response.ToolCalls[0].Name != "status" || !strings.Contains(string(response.ToolCalls[0].Arguments), `"all":true`) {
		t.Fatalf("unexpected Anthropic response: %+v", response)
	}
	if usage.InputTokens != 12 || usage.OutputTokens != 4 {
		t.Fatalf("unexpected Anthropic usage: %+v", usage)
	}
	if chatRequestBody.System != "first system\n\nsecond system" || len(chatRequestBody.Tools) != 2 {
		t.Fatalf("unexpected Anthropic request: %+v", chatRequestBody)
	}
	if len(chatRequestBody.Messages) != 3 || chatRequestBody.Messages[0].Role != "user" ||
		len(chatRequestBody.Messages[0].Content) != 2 {
		t.Fatalf("Anthropic messages were not merged: %+v", chatRequestBody.Messages)
	}
	if !sawAPIKey {
		t.Fatal("Anthropic headers were not sent")
	}

	models, err := provider.Models(context.Background())
	if err != nil || len(models) != 1 || models[0].ID != "claude-test" {
		t.Fatalf("Anthropic models: %#v, %v", models, err)
	}
	stream, err := provider.ChatStream(context.Background(), "claude-test", messages)
	if err != nil {
		t.Fatalf("Anthropic stream: %v", err)
	}
	var chunks []SSEChunk
	for chunk := range stream {
		chunks = append(chunks, chunk)
	}
	if len(chunks) != 1 || chunks[0].Event != "content_block_delta" {
		t.Fatalf("Anthropic stream chunks: %#v", chunks)
	}
}

func TestAnthropicProviderErrorPaths(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"status", http.StatusBadGateway, "unavailable"},
		{"decode", http.StatusOK, "{"},
	} {
		t.Run("chat "+tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			provider := NewProvider(server.URL, "key")
			provider.APIFormat = "anthropic"
			if _, _, err := provider.Chat(context.Background(), "model", nil, nil); err == nil {
				t.Fatal("expected Anthropic chat error")
			}
		})
		t.Run("models "+tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			provider := NewProvider(server.URL, "key")
			provider.APIFormat = "anthropic"
			if _, err := provider.Models(context.Background()); err == nil {
				t.Fatal("expected Anthropic models error")
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no stream", http.StatusBadGateway)
	}))
	provider := NewProvider(server.URL, "key")
	provider.APIFormat = "anthropic"
	if _, err := provider.ChatStream(context.Background(), "model", nil); err == nil {
		t.Fatal("expected Anthropic stream error")
	}
	server.Close()
	if _, _, err := provider.Chat(context.Background(), "model", nil, nil); err == nil {
		t.Fatal("expected Anthropic request failure")
	}
	if _, err := provider.Models(context.Background()); err == nil {
		t.Fatal("expected Anthropic model request failure")
	}
}

type immediateErrorReader struct{}

func (immediateErrorReader) Read([]byte) (int, error) { return 0, errors.New("stream broke") }

func TestProviderSelectionHelpersAndSSEErrors(t *testing.T) {
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })

	config.SetTestConfig(nil)
	if AIConfigured(nil, nil) || NewAIProvider(context.Background(), nil, nil) != nil || calculateCost("model", 1, 1, 1) != 0 {
		t.Fatal("nil configuration reported an AI provider or cost")
	}

	cfg := &config.Config{Support: config.SupportConfig{
		InferenceBaseURL: "https://fallback.test/v1",
		UserAPIKey:       "byok-key",
		UserAPIFormat:    "anthropic",
	}}
	if newBYOKProvider(&config.Config{}) != nil {
		t.Fatal("BYOK provider created without a key")
	}
	byok := newBYOKProvider(cfg)
	if byok == nil || byok.BaseURL != "https://fallback.test/v1" || byok.APIFormat != "anthropic" {
		t.Fatalf("unexpected BYOK provider: %+v", byok)
	}
	cfg.Support.BYOKEnabled = true
	cfg.Support.UserBaseURL = "https://user.test/v1/"
	config.SetTestConfig(cfg)
	if !AIConfigured(nil, nil) {
		t.Fatal("configured BYOK was not detected")
	}
	selected := NewAIProvider(context.Background(), nil, nil)
	if selected == nil || selected.BaseURL != "https://user.test/v1" || selected.APIKey != "byok-key" {
		t.Fatalf("unexpected selected BYOK provider: %+v", selected)
	}

	fake := connect.NewFakeClient()
	if _, err := fake.Activate(context.Background(), "12345678-connect-one"); err != nil {
		t.Fatal(err)
	}
	if _, err := fake.Provision(context.Background(), connect.ServiceAI); err != nil {
		t.Fatal(err)
	}
	config.SetTestConfig(&config.Config{})
	if !AIConfigured(fake, nil) {
		t.Fatal("connected AI service was not detected")
	}
	selected = NewAIProvider(context.Background(), fake, nil)
	if selected == nil || selected.APIKey == "" || selected.BaseURL == "" {
		t.Fatalf("Connect AI provider was not provisioned: %+v", selected)
	}
	if status, ok := latestConnectStatus(fake, nil); !ok || status == nil || !status.Connected {
		t.Fatalf("latest Connect status: %+v, %v", status, ok)
	}
	if _, ok := latestConnectStatus(nil, nil); ok {
		t.Fatal("nil Connect client returned status")
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			_ = json.NewEncoder(w).Encode(ModelsResponse{Data: nil})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	config.SetTestConfig(&config.Config{Support: config.SupportConfig{
		BYOKEnabled: true,
		UserAPIKey:  "key",
		UserBaseURL: server.URL,
	}})
	models, err := ListAIModels(context.Background(), nil, nil)
	if err != nil || len(models) != 0 {
		t.Fatalf("nil model list was not normalized: %#v, %v", models, err)
	}

	provider := NewProvider("", "")
	ch := make(chan SSEChunk, 1)
	provider.parseSSE(immediateErrorReader{}, ch)
	close(ch)
	chunk := <-ch
	if chunk.Err == nil || !strings.Contains(chunk.Err.Error(), "stream broke") {
		t.Fatalf("SSE scanner error was not reported: %+v", chunk)
	}

	eventData, err := (Event{Type: EventDone, Data: DoneData{Reason: "complete"}}).MarshalJSON()
	if err != nil || !strings.Contains(string(eventData), `"done"`) {
		t.Fatalf("event JSON = %s, %v", eventData, err)
	}
}
