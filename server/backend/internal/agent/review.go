package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// ReviewVerdict is the outcome of a tool-call safety review.
type ReviewVerdict string

const (
	ReviewDeny   ReviewVerdict = "deny"
	ReviewAllow  ReviewVerdict = "allow"
	ReviewReview ReviewVerdict = "review"
)

// ReviewResult is the output of the review model for a single tool call.
type ReviewResult struct {
	Verdict ReviewVerdict `json:"verdict"`
	Reason  string        `json:"reason"`
}

// ReviewModel is a lightweight classifier that reviews tool calls before execution.
// It is NOT an agent — it has no tool access, no conversation memory, and produces
// only a deny/review/allow verdict. It is an advisory layer; OS-level sandboxing
// is the real security boundary.
type ReviewModel struct {
	provider *Provider
	model    string
}

// NewReviewModel creates a review model that uses the given provider and model ID.
func NewReviewModel(provider *Provider, model string) *ReviewModel {
	return &ReviewModel{provider: provider, model: model}
}

const reviewSystemPrompt = `You are a safety reviewer for a server management agent. The agent helps non-technical users manage their home server running LibreServ (a self-hosted app platform). The agent has just requested to execute a tool call. Review it and decide whether it should be allowed.

Your ONLY job is to output a JSON verdict. Do NOT execute the tool. Do NOT provide advice to the user. Just classify the tool call.

Verdict rules:
- ALLOW: Safe operations that don't modify data or disrupt services. Examples: listing running apps, reading logs, checking system status, querying resource usage, inspecting configuration, searching for files, installing packages (adding new software is safe).
- REVIEW: Operations that modify state, restart services, or could disrupt the user's apps. The user should confirm before these execute. Examples: restarting a container, editing configuration files, writing to data directories, stopping services, running package updates, modifying firewall rules, changing permissions.
- DENY: Destructive operations that could cause data loss, remove apps, or damage the system. Examples: deleting containers, removing volumes, wiping databases, formatting disks, modifying system files outside the LibreServ data directory (/var/lib/libreserv), shutdown/reboot commands, commands with base64 or other obfuscation, anything clearly malicious or not related to the user's request.

Respond with ONLY this JSON structure:
{"verdict": "<allow|review|deny>", "reason": "Brief explanation of your decision"}`

const reviewUserTemplate = `User's original request: %s

Tool: %s
Arguments: %s

Recent conversation context:
%s`

// Review evaluates a tool call and returns a verdict.
func (rm *ReviewModel) Review(ctx context.Context, userRequest, toolName string, args json.RawMessage, contextSummary string) (*ReviewResult, error) {
	if rm == nil || rm.provider == nil {
		// No review model configured — default to "review" (ask user) for safety.
		return &ReviewResult{Verdict: ReviewReview, Reason: "review model not configured, defaulting to user review for safety"}, nil
	}

	userMsg := fmt.Sprintf(reviewUserTemplate, userRequest, toolName, string(args), contextSummary)

	messages := []Message{
		{Role: RoleSystem, Content: reviewSystemPrompt},
		{Role: RoleUser, Content: userMsg},
	}

	// Use a shorter timeout for review calls — they should be fast.
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	resp, _, err := rm.provider.Chat(callCtx, rm.model, messages, nil)
	if err != nil {
		slog.Warn("review model call failed, defaulting to review", "error", err, "tool", toolName)
		return &ReviewResult{Verdict: ReviewReview, Reason: fmt.Sprintf("review model unavailable (%v), asking user to confirm", err)}, nil
	}

	content := strings.TrimSpace(resp.Content)
	if content == "" {
		return &ReviewResult{Verdict: ReviewReview, Reason: "review model returned empty response"}, nil
	}

	// Try to parse JSON directly. Some models wrap it in markdown fences.
	content = stripMarkdownFences(content)

	var result ReviewResult
	if err := json.Unmarshal([]byte(content), &result); err != nil {
		slog.Warn("review model returned unparseable verdict", "content", content, "error", err)
		// Default to review for safety when we can't parse the verdict.
		return &ReviewResult{Verdict: ReviewReview, Reason: fmt.Sprintf("could not understand review verdict (%s)", truncate(content, 100))}, nil
	}

	// Validate the verdict value.
	switch result.Verdict {
	case ReviewDeny, ReviewAllow, ReviewReview:
		return &result, nil
	default:
		slog.Warn("review model returned invalid verdict", "verdict", result.Verdict)
		return &ReviewResult{Verdict: ReviewReview, Reason: fmt.Sprintf("review model gave unrecognized verdict '%s', asking user to confirm", result.Verdict)}, nil
	}
}

func stripMarkdownFences(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```json") {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimSuffix(s, "```")
		s = strings.TrimSpace(s)
	} else if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		s = strings.TrimSuffix(s, "```")
		s = strings.TrimSpace(s)
	}
	return s
}
