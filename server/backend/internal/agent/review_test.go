package agent

import (
	"testing"
)

func TestStripMarkdownFences(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"```json\n{\"verdict\":\"allow\"}\n```", "{\"verdict\":\"allow\"}"},
		{"```\n{\"verdict\":\"deny\"}\n```", "{\"verdict\":\"deny\"}"},
		{"{\"verdict\":\"review\"}", "{\"verdict\":\"review\"}"},
		{"  {\"verdict\":\"allow\",\"reason\":\"safe\"}  ", "{\"verdict\":\"allow\",\"reason\":\"safe\"}"},
	}

	for _, tt := range tests {
		result := stripMarkdownFences(tt.input)
		if result != tt.expected {
			t.Errorf("stripMarkdownFences(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestReviewVerdictConstants(t *testing.T) {
	if ReviewDeny != "deny" {
		t.Errorf("ReviewDeny = %q, want %q", ReviewDeny, "deny")
	}
	if ReviewAllow != "allow" {
		t.Errorf("ReviewAllow = %q, want %q", ReviewAllow, "allow")
	}
	if ReviewReview != "review" {
		t.Errorf("ReviewReview = %q, want %q", ReviewReview, "review")
	}
}

func TestReviewModelNilSafety(t *testing.T) {
	// A nil review model should default to "review" verdict for safety.
	var rm *ReviewModel
	result, err := rm.Review(nil, "test request", "bash", nil, "no context")
	if err != nil {
		t.Fatalf("nil review model should not error: %v", err)
	}
	if result.Verdict != ReviewReview {
		t.Errorf("nil review model verdict = %q, want %q", result.Verdict, ReviewReview)
	}
	if result.Reason == "" {
		t.Error("nil review model should provide a reason")
	}
}

func TestReviewModelNilProvider(t *testing.T) {
	rm := NewReviewModel(nil, "test-model")
	result, err := rm.Review(nil, "test request", "bash", nil, "no context")
	if err != nil {
		t.Fatalf("nil provider review model should not error: %v", err)
	}
	if result.Verdict != ReviewReview {
		t.Errorf("nil provider verdict = %q, want %q", result.Verdict, ReviewReview)
	}
}

func TestNewReviewModel(t *testing.T) {
	rm := NewReviewModel(nil, "test-model")
	if rm == nil {
		t.Fatal("NewReviewModel returned nil")
	}
	if rm.model != "test-model" {
		t.Errorf("model = %q, want %q", rm.model, "test-model")
	}
}
