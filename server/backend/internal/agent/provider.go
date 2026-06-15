package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
)

type Provider struct {
	BaseURL    string
	APIKey     string
	DeviceID   string
	APIFormat  string // "openai" or "anthropic"
	HTTPClient *http.Client
}

func NewProvider(baseURL, apiKey string) *Provider {
	return &Provider{
		BaseURL:   strings.TrimRight(baseURL, "/"),
		APIKey:    apiKey,
		APIFormat: "openai",
		HTTPClient: &http.Client{
			Timeout: 5 * time.Minute,
			Transport: &http.Transport{
				MaxIdleConns:        50,
				MaxIdleConnsPerHost: 20,
				MaxConnsPerHost:     30,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

func newBYOKProvider(cfg *config.Config) *Provider {
	if cfg.Support.UserAPIKey == "" {
		return nil
	}
	baseURL := cfg.Support.UserBaseURL
	if baseURL == "" {
		baseURL = cfg.Support.InferenceBaseURL
	}
	p := NewProvider(baseURL, cfg.Support.UserAPIKey)
	if cfg.Support.UserAPIFormat != "" {
		p.APIFormat = cfg.Support.UserAPIFormat
	}
	return p
}

// AIConfigured reports whether an AI provider can be built (without actually
// provisioning credentials from Connect).
func AIConfigured(client connect.Client, checker *connect.EntitlementChecker) bool {
	cfg := config.Get()
	if cfg == nil {
		return false
	}
	if cfg.Support.BYOKEnabled && cfg.Support.UserAPIKey != "" {
		return true
	}
	status, ok := latestConnectStatus(client, checker)
	if !ok {
		return false
	}
	svc, found := status.Services[connect.ServiceAI]
	return found && svc.State == connect.ServiceConnected
}

// NewAIProvider returns a provider for the active AI source:
//  1. BYOK if enabled and an API key is configured.
//  2. LibreServ Connect's provisioned AI credentials if the AI service is connected.
//  3. nil otherwise.
func NewAIProvider(ctx context.Context, client connect.Client, checker *connect.EntitlementChecker) *Provider {
	cfg := config.Get()
	if cfg == nil {
		return nil
	}
	if cfg.Support.BYOKEnabled && cfg.Support.UserAPIKey != "" {
		return newBYOKProvider(cfg)
	}

	status, ok := latestConnectStatus(client, checker)
	if !ok {
		return nil
	}
	svc, found := status.Services[connect.ServiceAI]
	if !found || svc.State != connect.ServiceConnected {
		return nil
	}
	creds, err := client.Provision(ctx, connect.ServiceAI)
	if err != nil || creds == nil || creds.AI == nil {
		return nil
	}
	p := NewProvider(creds.AI.BaseURL, creds.AI.APIKey)
	p.APIFormat = "openai"
	return p
}

// ListAIModels returns available models from the configured AI source.
func ListAIModels(ctx context.Context, client connect.Client, checker *connect.EntitlementChecker) ([]ModelInfo, error) {
	provider := NewAIProvider(ctx, client, checker)
	if provider == nil {
		return []ModelInfo{}, nil
	}
	models, err := provider.Models(ctx)
	if err != nil {
		return nil, err
	}
	if models == nil {
		return []ModelInfo{}, nil
	}
	return models, nil
}

func latestConnectStatus(client connect.Client, checker *connect.EntitlementChecker) (*connect.ConnectStatus, bool) {
	if checker != nil {
		status := checker.Status()
		return status, status != nil && status.Connected
	}
	if client == nil {
		return nil, false
	}
	status, err := client.Status(context.Background())
	return status, err == nil && status != nil && status.Connected
}

func calculateCost(model string, inputTokens, outputTokens, cacheTokens int) float64 {
	cfg := config.Get()
	if cfg == nil {
		return 0
	}
	pricing, ok := cfg.Support.Pricing[model]
	if !ok {
		return 0
	}
	inputCost := float64(inputTokens) / 1_000_000 * pricing.InputPer1M
	outputCost := float64(outputTokens) / 1_000_000 * pricing.OutputPer1M
	cacheCost := float64(cacheTokens) / 1_000_000 * pricing.CachePer1M
	return inputCost + outputCost + cacheCost
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Tools       []interface{} `json:"tools,omitempty"`
	Stream      bool          `json:"stream"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Temperature float64       `json:"temperature,omitempty"`
}

type chatMessage struct {
	Role       string         `json:"role"`
	Content    string         `json:"content,omitempty"`
	ToolCalls  []chatToolCall `json:"tool_calls,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
}

type chatToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function chatFunction `json:"function"`
}

type chatFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type chatResponse struct {
	ID      string `json:"id"`
	Choices []struct {
		Message struct {
			Role      string         `json:"role"`
			Content   string         `json:"content"`
			ToolCalls []chatToolCall `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens        int `json:"prompt_tokens"`
		CompletionTokens    int `json:"completion_tokens"`
		TotalTokens         int `json:"total_tokens"`
		PromptTokensDetails struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
}

type ModelInfo struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

type ModelsResponse struct {
	Data []ModelInfo `json:"data"`
}

func (p *Provider) setAuthHeaders(req *http.Request) {
	if p.DeviceID != "" {
		req.Header.Set("Authorization", "Bearer "+p.APIKey)
		req.Header.Set("X-Client-Role", "device")
		req.Header.Set("X-Device-ID", p.DeviceID)
	} else {
		req.Header.Set("Authorization", "Bearer "+p.APIKey)
	}
}

func (p *Provider) chatCompletionsURL() string {
	if p.DeviceID != "" {
		return p.BaseURL + "/api/v1/inference/chat/completions"
	}
	return p.BaseURL + "/chat/completions"
}

func (p *Provider) modelsURL() string {
	if p.DeviceID != "" {
		return p.BaseURL + "/api/v1/inference/models"
	}
	return p.BaseURL + "/models"
}

func (p *Provider) Chat(ctx context.Context, model string, messages []Message, toolDefs []map[string]interface{}) (*AgentResponse, *UsageInfo, error) {
	if p.APIFormat == "anthropic" {
		return p.anthropicChat(ctx, model, messages, toolDefs)
	}
	return p.openaiChat(ctx, model, messages, toolDefs)
}

func (p *Provider) openaiChat(ctx context.Context, model string, messages []Message, toolDefs []map[string]interface{}) (*AgentResponse, *UsageInfo, error) {
	reqMsgs := make([]chatMessage, 0, len(messages))
	for _, m := range messages {
		cm := chatMessage{Role: string(m.Role), Content: m.Content, ToolCallID: m.ToolCallID}
		for _, tc := range m.ToolCalls {
			cm.ToolCalls = append(cm.ToolCalls, chatToolCall{
				ID:   tc.ID,
				Type: "function",
				Function: chatFunction{
					Name:      tc.Name,
					Arguments: string(tc.Arguments),
				},
			})
		}
		reqMsgs = append(reqMsgs, cm)
	}

	body := chatRequest{
		Model:    model,
		Messages: reqMsgs,
		Stream:   false,
	}
	if len(toolDefs) > 0 {
		for _, td := range toolDefs {
			body.Tools = append(body.Tools, td)
		}
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.chatCompletionsURL(), bytes.NewReader(data))
	if err != nil {
		return nil, nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	p.setAuthHeaders(req)

	resp, err := p.HTTPClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusPaymentRequired {
		bodyBytes, _ := io.ReadAll(resp.Body)
		slog.Warn("inference credit limit reached", "status", resp.StatusCode, "body", string(bodyBytes))
		return nil, nil, fmt.Errorf("your monthly AI support credit has been used up; upgrade your plan in Settings to get more, or wait for next month's reset")
	}

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, nil, fmt.Errorf("API returned %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var chatResp chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&chatResp); err != nil {
		return nil, nil, fmt.Errorf("decode response: %w", err)
	}

	if len(chatResp.Choices) == 0 {
		return nil, nil, fmt.Errorf("no response choices returned")
	}

	choice := chatResp.Choices[0]
	result := &AgentResponse{Content: choice.Message.Content}

	for _, tc := range choice.Message.ToolCalls {
		var args = json.RawMessage(tc.Function.Arguments)
		if len(args) == 0 {
			args = json.RawMessage("{}")
		}
		result.ToolCalls = append(result.ToolCalls, AgentToolCall{
			ID:        tc.ID,
			Name:      tc.Function.Name,
			Arguments: args,
		})
	}

	inputTokens := chatResp.Usage.PromptTokens - chatResp.Usage.PromptTokensDetails.CachedTokens
	if inputTokens < 0 {
		inputTokens = 0
	}
	usage := &UsageInfo{
		InputTokens:  inputTokens,
		OutputTokens: chatResp.Usage.CompletionTokens,
		CacheTokens:  chatResp.Usage.PromptTokensDetails.CachedTokens,
	}
	usage.CostUSD = calculateCost(model, usage.InputTokens, usage.OutputTokens, usage.CacheTokens)

	return result, usage, nil
}

func (p *Provider) Models(ctx context.Context) ([]ModelInfo, error) {
	if p.APIFormat == "anthropic" {
		return p.anthropicModels(ctx)
	}
	return p.openaiModels(ctx)
}

func (p *Provider) openaiModels(ctx context.Context) ([]ModelInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.modelsURL(), nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	p.setAuthHeaders(req)

	resp, err := p.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned %d", resp.StatusCode)
	}

	var modelsResp ModelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&modelsResp); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return modelsResp.Data, nil
}

func (p *Provider) ChatStream(ctx context.Context, model string, messages []Message) (<-chan SSEChunk, error) {
	if p.APIFormat == "anthropic" {
		return p.anthropicChatStream(ctx, model, messages)
	}
	return p.openaiChatStream(ctx, model, messages)
}

func (p *Provider) openaiChatStream(ctx context.Context, model string, messages []Message) (<-chan SSEChunk, error) {
	reqMsgs := make([]chatMessage, 0, len(messages))
	for _, m := range messages {
		cm := chatMessage{Role: string(m.Role), Content: m.Content, ToolCallID: m.ToolCallID}
		for _, tc := range m.ToolCalls {
			cm.ToolCalls = append(cm.ToolCalls, chatToolCall{
				ID:   tc.ID,
				Type: "function",
				Function: chatFunction{
					Name:      tc.Name,
					Arguments: string(tc.Arguments),
				},
			})
		}
		reqMsgs = append(reqMsgs, cm)
	}

	body := chatRequest{
		Model:    model,
		Messages: reqMsgs,
		Stream:   true,
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.chatCompletionsURL(), bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	p.setAuthHeaders(req)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := p.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("API returned %d", resp.StatusCode)
	}

	ch := make(chan SSEChunk, 256)
	go func() {
		defer close(ch)
		defer resp.Body.Close()
		p.parseSSE(resp.Body, ch)
	}()

	return ch, nil
}

type SSEChunk struct {
	Data  string
	Event string
}

func (p *Provider) parseSSE(r io.Reader, ch chan<- SSEChunk) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var event string

	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: ") {
			event = strings.TrimPrefix(line, "event: ")
			continue
		}
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				return
			}
			ch <- SSEChunk{Data: data, Event: event}
			event = ""
		}
	}
}

// --- Anthropic Messages API support ---

type anthropicMessage struct {
	Role    string                  `json:"role"`
	Content []anthropicContentBlock `json:"content"`
}

type anthropicContentBlock struct {
	Type  string                 `json:"type"`
	Text  string                 `json:"text,omitempty"`
	ID    string                 `json:"id,omitempty"`
	Name  string                 `json:"name,omitempty"`
	Input map[string]interface{} `json:"input,omitempty"`

	// For tool_result content blocks
	ToolUseID string `json:"tool_use_id,omitempty"`
	Content_  string `json:"content,omitempty"` // nested content for tool_result
}

type anthropicTool struct {
	Name        string      `json:"name"`
	Description string      `json:"description,omitempty"`
	InputSchema interface{} `json:"input_schema,omitempty"`
}

type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	System    string             `json:"system,omitempty"`
	Messages  []anthropicMessage `json:"messages"`
	Tools     []anthropicTool    `json:"tools,omitempty"`
	Stream    bool               `json:"stream,omitempty"`
}

type anthropicResponse struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Role    string `json:"role"`
	Content []struct {
		Type  string                 `json:"type"`
		Text  string                 `json:"text,omitempty"`
		ID    string                 `json:"id,omitempty"`
		Name  string                 `json:"name,omitempty"`
		Input map[string]interface{} `json:"input,omitempty"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

func (p *Provider) anthropicSetHeaders(req *http.Request) {
	req.Header.Set("x-api-key", p.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Content-Type", "application/json")
}

func (p *Provider) anthropicMessagesURL() string {
	return p.BaseURL + "/messages"
}

func (p *Provider) anthropicModelsURL() string {
	return p.BaseURL + "/models"
}

func (p *Provider) anthropicChat(ctx context.Context, model string, messages []Message, toolDefs []map[string]interface{}) (*AgentResponse, *UsageInfo, error) {
	reqMsgs, systemPrompt := p.toAnthropicMessages(messages)

	body := anthropicRequest{
		Model:     model,
		MaxTokens: 16384,
		System:    systemPrompt,
		Messages:  reqMsgs,
		Stream:    false,
	}

	if len(toolDefs) > 0 {
		for _, td := range toolDefs {
			fn, ok := td["function"]
			if !ok {
				continue
			}
			fnMap, ok := fn.(map[string]interface{})
			if !ok {
				continue
			}
			name, _ := fnMap["name"].(string)
			desc, _ := fnMap["description"].(string)
			if name == "" {
				continue
			}

			// parameters may be map[string]interface{} (deserialized from JSON)
			// or json.RawMessage (set directly by ToolDefinitions()).
			var inputSchema interface{}
			switch p := fnMap["parameters"].(type) {
			case map[string]interface{}:
				inputSchema = p
			case json.RawMessage:
				if len(p) > 0 {
					var parsed map[string]interface{}
					if err := json.Unmarshal(p, &parsed); err == nil {
						inputSchema = parsed
					}
				}
			}

			body.Tools = append(body.Tools, anthropicTool{
				Name:        name,
				Description: desc,
				InputSchema: inputSchema,
			})
		}
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.anthropicMessagesURL(), bytes.NewReader(data))
	if err != nil {
		return nil, nil, fmt.Errorf("create request: %w", err)
	}
	p.anthropicSetHeaders(req)

	resp, err := p.HTTPClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, nil, fmt.Errorf("Anthropic API returned %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var aResp anthropicResponse
	if err := json.NewDecoder(resp.Body).Decode(&aResp); err != nil {
		return nil, nil, fmt.Errorf("decode response: %w", err)
	}

	result := &AgentResponse{}
	for _, block := range aResp.Content {
		switch block.Type {
		case "text":
			result.Content += block.Text
		case "tool_use":
			args, _ := json.Marshal(block.Input)
			if len(args) == 0 {
				args = json.RawMessage("{}")
			}
			result.ToolCalls = append(result.ToolCalls, AgentToolCall{
				ID:        block.ID,
				Name:      block.Name,
				Arguments: args,
			})
		}
	}

	usage := &UsageInfo{
		InputTokens:  aResp.Usage.InputTokens,
		OutputTokens: aResp.Usage.OutputTokens,
	}
	usage.CostUSD = calculateCost(model, usage.InputTokens, usage.OutputTokens, usage.CacheTokens)

	return result, usage, nil
}

func (p *Provider) toAnthropicMessages(messages []Message) ([]anthropicMessage, string) {
	var systemParts []string
	var rawMsgs []anthropicMessage

	// First pass: extract system messages and convert others
	for _, m := range messages {
		switch m.Role {
		case "system":
			systemParts = append(systemParts, m.Content)
		case "user":
			rawMsgs = append(rawMsgs, anthropicMessage{
				Role: "user",
				Content: []anthropicContentBlock{{
					Type: "text",
					Text: m.Content,
				}},
			})
		case "assistant":
			blocks := []anthropicContentBlock{}
			if m.Content != "" {
				blocks = append(blocks, anthropicContentBlock{Type: "text", Text: m.Content})
			}
			for _, tc := range m.ToolCalls {
				var input map[string]interface{}
				if err := json.Unmarshal(tc.Arguments, &input); err != nil {
					input = map[string]interface{}{}
				}
				blocks = append(blocks, anthropicContentBlock{
					Type:  "tool_use",
					ID:    tc.ID,
					Name:  tc.Name,
					Input: input,
				})
			}
			rawMsgs = append(rawMsgs, anthropicMessage{Role: "assistant", Content: blocks})
		case "tool":
			rawMsgs = append(rawMsgs, anthropicMessage{
				Role: "user",
				Content: []anthropicContentBlock{{
					Type:      "tool_result",
					ToolUseID: m.ToolCallID,
					Content_:  m.Content,
				}},
			})
		}
	}

	// Second pass: merge consecutive same-role messages to satisfy Anthropic's
	// strict user/assistant alternation requirement.
	var result []anthropicMessage
	for _, msg := range rawMsgs {
		if len(result) > 0 && result[len(result)-1].Role == msg.Role {
			// Merge content blocks into the previous message
			result[len(result)-1].Content = append(result[len(result)-1].Content, msg.Content...)
		} else {
			result = append(result, msg)
		}
	}

	return result, strings.Join(systemParts, "\n\n")
}

func (p *Provider) anthropicModels(ctx context.Context) ([]ModelInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.anthropicModelsURL(), nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	p.anthropicSetHeaders(req)

	resp, err := p.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Anthropic models API returned %d", resp.StatusCode)
	}

	// Umans returns OpenAI-compatible /v1/models format even with x-api-key auth
	var modelsResp ModelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&modelsResp); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return modelsResp.Data, nil
}

func (p *Provider) anthropicChatStream(ctx context.Context, model string, messages []Message) (<-chan SSEChunk, error) {
	reqMsgs, systemPrompt := p.toAnthropicMessages(messages)

	body := anthropicRequest{
		Model:     model,
		MaxTokens: 16384,
		System:    systemPrompt,
		Messages:  reqMsgs,
		Stream:    true,
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.anthropicMessagesURL(), bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	p.anthropicSetHeaders(req)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := p.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("Anthropic API returned %d", resp.StatusCode)
	}

	ch := make(chan SSEChunk, 256)
	go func() {
		defer close(ch)
		defer resp.Body.Close()
		p.parseSSE(resp.Body, ch)
	}()

	return ch, nil
}
