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
// only a deny/review/allow verdict. It is an advisory layer on top of the real
// security boundary, which is the OS-level sandbox that executes the tool (see
// internal/agent/sandbox). The review model decides whether a call should proceed
// or be escalated to the user; the sandbox contains the damage if a call that
// should not proceed somehow does.
//
// In autonomous mode (auto, used by the self-healing agent) there is no human to
// confirm borderline actions, so the "review" verdict is removed from the model's
// options: it must decide allow or deny on its own, and any ambiguity fails safe
// to deny. Auto mode never silently approves a call — it only runs what the model
// explicitly allows.
type ReviewModel struct {
	provider *Provider
	model    string
}

// NewReviewModel creates a review model that uses the given provider and model ID.
func NewReviewModel(provider *Provider, model string) *ReviewModel {
	return &ReviewModel{provider: provider, model: model}
}

// reviewSystemPromptBase is the shared safety-reviewer prompt. It describes the
// three possible verdicts. In autonomous mode the review clause below removes
// "review" as an option so the model must choose allow or deny.
const reviewSystemPromptBase = `You are a safety reviewer for a server management agent. The agent helps non-technical users manage their home server running LibreServ (a self-hosted app platform). The agent has just requested to execute a tool call. Review it and decide whether it should be allowed.

Your ONLY job is to output a JSON verdict. Do NOT execute the tool. Do NOT provide advice to the user. Just classify the tool call.

Verdict rules:
- ALLOW: Safe, read-only or additive operations that do not touch user data and do not risk disrupting services. Examples: listing running apps, reading logs, checking system status, querying resource usage, inspecting non-sensitive configuration, searching for files, installing packages (adding new software is safe).
- REVIEW: Anything that touches user data, or modifies state, or could disrupt the user's apps. The user must confirm before these run. ALWAYS choose REVIEW — never ALLOW — for: reading or modifying app data, backups, databases, personal files, or anything under the LibreServ data directory (/var/lib/libreserv); restarting or stopping containers; editing configuration files; running package updates; modifying firewall rules; changing permissions.
- DENY: Destructive operations that could break the system or cause data loss. Examples: deleting containers or volumes, wiping databases, formatting disks, rm -rf / or --no-preserve-root, modifying system files outside the LibreServ data directory (/etc/passwd, /usr, /bin, /boot), shutdown or reboot commands, commands using base64 or other obfuscation, anything clearly malicious or unrelated to the user's request.

Respond with ONLY this JSON structure:
{"verdict": "<allow|review|deny>", "reason": "Brief explanation of your decision"}`

// reviewAutoClause overrides the base prompt in autonomous mode: there is no human
// to confirm actions, so "review" is not an available verdict.
const reviewAutoClause = `

OPERATING MODE: autonomous. There is no human available to confirm actions, so you MUST NOT return "review". Choose only "allow" or "deny". For an operation you would normally mark "review", allow it only when it is routine and reversible (for example restarting a known container, or editing a configuration file inside the LibreServ data directory); deny anything destructive, irreversible, or that could damage the user's apps or data. When in doubt, deny.`

// buildReviewSystemPrompt returns the system prompt for the reviewer, adjusted
// for the operating mode.
func buildReviewSystemPrompt(autoMode bool) string {
	if autoMode {
		return reviewSystemPromptBase + reviewAutoClause
	}
	return reviewSystemPromptBase
}

const reviewUserTemplate = `User's original request: %s

Tool: %s
Arguments: %s

Recent conversation context:
%s`

// Review evaluates a tool call and returns a verdict. When autoMode is true the
// reviewer operates autonomously: it must not return "review" (there is no human
// to confirm), and any failure to decide fails safe to "deny" rather than
// escalating or allowing.
func (rm *ReviewModel) Review(ctx context.Context, userRequest, toolName string, args json.RawMessage, contextSummary string, autoMode bool) (*ReviewResult, error) {
	if rm == nil || rm.provider == nil {
		// No review model configured. In autonomous mode there is no human to fall
		// back to either, so fail safe: deny. In assisted mode, escalate to the user.
		if autoMode {
			return &ReviewResult{Verdict: ReviewDeny, Reason: "safety review is not configured; autonomous mode will not run actions without review"}, nil
		}
		return &ReviewResult{Verdict: ReviewReview, Reason: "review model not configured, defaulting to user review for safety"}, nil
	}

	userMsg := fmt.Sprintf(reviewUserTemplate, userRequest, toolName, string(args), contextSummary)

	messages := []Message{
		{Role: RoleSystem, Content: buildReviewSystemPrompt(autoMode)},
		{Role: RoleUser, Content: userMsg},
	}

	// Use a shorter timeout for review calls — they should be fast.
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	resp, _, err := rm.provider.Chat(callCtx, rm.model, messages, nil)
	if err != nil {
		slog.Warn("review model call failed", "error", err, "tool", toolName, "auto", autoMode)
		if autoMode {
			return &ReviewResult{Verdict: ReviewDeny, Reason: fmt.Sprintf("safety review unavailable (%v); autonomous mode will not run the action", err)}, nil
		}
		return &ReviewResult{Verdict: ReviewReview, Reason: fmt.Sprintf("review model unavailable (%v), asking user to confirm", err)}, nil
	}

	content := strings.TrimSpace(resp.Content)
	if content == "" {
		return rm.fallback(autoMode, "review model returned empty response"), nil
	}

	// Try to parse JSON directly. Some models wrap it in markdown fences.
	content = stripMarkdownFences(content)

	var result ReviewResult
	if err := json.Unmarshal([]byte(content), &result); err != nil {
		slog.Warn("review model returned unparseable verdict", "content", content, "error", err)
		return rm.fallback(autoMode, fmt.Sprintf("could not understand review verdict (%s)", truncate(content, 100))), nil
	}

	// Validate the verdict value.
	switch result.Verdict {
	case ReviewDeny, ReviewAllow:
		return &result, nil
	case ReviewReview:
		// In autonomous mode the model was told not to return "review". If it does
		// anyway, fail safe: deny rather than silently allowing or waiting for a
		// human who is not there.
		if autoMode {
			slog.Warn("review model returned 'review' in autonomous mode; denying", "tool", toolName)
			return &ReviewResult{Verdict: ReviewDeny, Reason: fmt.Sprintf("review was inconclusive in autonomous mode: %s", result.Reason)}, nil
		}
		return &result, nil
	default:
		slog.Warn("review model returned invalid verdict", "verdict", result.Verdict)
		return rm.fallback(autoMode, fmt.Sprintf("review model gave unrecognized verdict '%s'", result.Verdict)), nil
	}
}

// fallback returns a safe verdict when the reviewer could not decide: deny in
// autonomous mode, otherwise escalate to the user.
func (rm *ReviewModel) fallback(autoMode bool, reason string) *ReviewResult {
	if autoMode {
		return &ReviewResult{Verdict: ReviewDeny, Reason: reason}
	}
	return &ReviewResult{Verdict: ReviewReview, Reason: reason}
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
