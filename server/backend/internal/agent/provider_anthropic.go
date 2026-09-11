package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

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
		return nil, nil, fmt.Errorf("anthropic API returned %d: %s", resp.StatusCode, string(bodyBytes))
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

	var result []anthropicMessage
	for _, msg := range rawMsgs {
		if len(result) > 0 && result[len(result)-1].Role == msg.Role {
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
		return nil, fmt.Errorf("anthropic models API returned %d", resp.StatusCode)
	}

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
		return nil, fmt.Errorf("anthropic API returned %d", resp.StatusCode)
	}

	ch := make(chan SSEChunk, 256)
	go func() {
		defer close(ch)
		defer resp.Body.Close()
		p.parseSSE(resp.Body, ch)
	}()

	return ch, nil
}
