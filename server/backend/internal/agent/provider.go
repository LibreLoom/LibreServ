package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

type Provider struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

func NewProvider(baseURL, apiKey string) *Provider {
	return &Provider{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
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

func NewProviderFromConfig() *Provider {
	cfg := config.Get()
	if cfg == nil {
		return nil
	}
	if cfg.Support.BYOKEnabled && cfg.Support.UserAPIKey != "" {
		baseURL := cfg.Support.UserBaseURL
		if baseURL == "" {
			baseURL = cfg.Support.InferenceBaseURL
		}
		return NewProvider(baseURL, cfg.Support.UserAPIKey)
	}
	return NewSharedProviderFromConfig()
}

func NewSharedProviderFromConfig() *Provider {
	cfg := config.Get()
	if cfg == nil {
		return nil
	}
	key := cfg.Support.InferenceAPIKey
	if key == "" {
		return nil
	}
	return NewProvider(cfg.Support.InferenceBaseURL, key)
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

func (p *Provider) Chat(ctx context.Context, model string, messages []Message, toolDefs []map[string]interface{}) (*AgentResponse, *UsageInfo, error) {
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

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/chat/completions", bytes.NewReader(data))
	if err != nil {
		return nil, nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)

	resp, err := p.HTTPClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

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
		var args json.RawMessage = json.RawMessage(tc.Function.Arguments)
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.BaseURL+"/models", nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+p.APIKey)

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

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/chat/completions", bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
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
