package agent

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

const summarySystemPrompt = `You summarize an in-progress support session on a LibreServ home server so a safety reviewer can judge an upcoming tool call.

Produce a concise, factual summary covering:
- What the user is trying to accomplish (their goal, in their own words).
- What the agent has done so far: which tools it called and their outcomes, which files or services it touched, and anything it changed.
- Any sensitive or user data involved (passwords, secrets, personal files, app data, backups).
- Anything pending, unresolved, or risky that the reviewer should know.

Rules:
- Be brief: a few short sentences or bullet points. Do not transcribe the whole conversation.
- State only what actually happened. Do not speculate, give advice, or invent details.
- If nothing relevant has happened yet, respond with: No prior activity.`

// SessionSummarizer produces a running summary of the conversation using a
// dedicated model, so the review model can judge tool calls with real context
// instead of a raw truncated transcript. It is optional: when not configured
// (or when the call fails) the loop falls back to buildContextSummary.
type SessionSummarizer struct {
	provider *Provider
	model    string
}

// NewSessionSummarizer creates a summarizer that uses the given provider and
// model ID. A nil provider or empty model makes the summarizer unavailable and
// the loop falls back to the transcript summary.
func NewSessionSummarizer(provider *Provider, model string) *SessionSummarizer {
	return &SessionSummarizer{provider: provider, model: model}
}

// Available reports whether a summary model is configured and usable.
func (s *SessionSummarizer) Available() bool {
	return s != nil && s.provider != nil && s.model != ""
}

// Summarize returns a concise summary of the session, or "" if the summarizer
// is unavailable. On a provider error it returns "" so the caller can fall back
// to the transcript summary rather than blocking the review.
func (s *SessionSummarizer) Summarize(ctx context.Context, messages []Message) (string, error) {
	if !s.Available() {
		return "", nil
	}
	userMsg := buildSummaryInput(messages)
	if strings.TrimSpace(userMsg) == "" {
		return "No prior activity.", nil
	}
	msgs := []Message{
		{Role: RoleSystem, Content: summarySystemPrompt},
		{Role: RoleUser, Content: userMsg},
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, _, err := s.provider.Chat(callCtx, s.model, msgs, nil)
	if err != nil {
		slog.Warn("session summary model call failed; falling back to transcript", "error", err)
		return "", err
	}
	return strings.TrimSpace(resp.Content), nil
}

// buildSummaryInput renders the conversation into a compact transcript for the
// summary model. It is bounded (last 30 entries, each truncated) so the summary
// call stays cheap even in long sessions.
func buildSummaryInput(messages []Message) string {
	const maxEntries = 30
	start := len(messages) - maxEntries
	if start < 0 {
		start = 0
	}
	var parts []string
	for _, m := range messages[start:] {
		switch m.Role {
		case RoleUser:
			parts = append(parts, fmt.Sprintf("User: %s", truncate(m.Content, 500)))
		case RoleAssistant:
			if m.Content != "" {
				parts = append(parts, fmt.Sprintf("Agent: %s", truncate(m.Content, 500)))
			}
			for _, tc := range m.ToolCalls {
				parts = append(parts, fmt.Sprintf("Agent called tool %s with: %s", tc.Name, truncate(string(tc.Arguments), 200)))
			}
		case RoleTool:
			parts = append(parts, fmt.Sprintf("Tool %s result: %s", m.ToolCallID, truncate(m.Content, 300)))
		}
	}
	return strings.Join(parts, "\n")
}
