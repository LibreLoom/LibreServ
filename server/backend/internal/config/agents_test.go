package config

import (
	"testing"
	"time"
)

func TestAgentConfigDefaults(t *testing.T) {
	cfg := &AgentConfig{}
	if cfg.MaxTurns != 0 {
		t.Error("zero-value MaxTurns should be 0")
	}
	if cfg.ReviewEnabled {
		t.Error("zero-value ReviewEnabled should be false")
	}
}

func TestAgentConfigFields(t *testing.T) {
	cfg := AgentConfig{
		MainModel:     "route/kimi-k2.6",
		ReviewModel:   "route/mimo-v2.5-pro",
		ReviewEnabled: true,
		SystemPrompt:  "Be helpful.",
		MaxTurns:      10,
		TurnTimeout:   5 * time.Minute,
		DataDirs:      []string{"/var/lib/libreserv", "/etc/libreserv"},
		SystemPlanID:  "basic",
	}

	if cfg.MainModel != "route/kimi-k2.6" {
		t.Errorf("MainModel = %q", cfg.MainModel)
	}
	if cfg.ReviewModel != "route/mimo-v2.5-pro" {
		t.Errorf("ReviewModel = %q", cfg.ReviewModel)
	}
	if !cfg.ReviewEnabled {
		t.Error("ReviewEnabled should be true")
	}
	if cfg.SystemPrompt != "Be helpful." {
		t.Errorf("SystemPrompt = %q", cfg.SystemPrompt)
	}
	if cfg.MaxTurns != 10 {
		t.Errorf("MaxTurns = %d, want 10", cfg.MaxTurns)
	}
	if len(cfg.DataDirs) != 2 {
		t.Errorf("DataDirs len = %d, want 2", len(cfg.DataDirs))
	}
}

func TestAgentConfigEmptyReviewModel(t *testing.T) {
	// When ReviewModel is empty, it should default to MainModel at runtime.
	// Config doesn't enforce this — it's the handler's job.
	cfg := AgentConfig{
		MainModel:     "route/kimi-k2.6",
		ReviewModel:   "",
		ReviewEnabled: true,
	}
	if cfg.ReviewModel != "" {
		t.Error("zero-value ReviewModel should be empty string")
	}
}

func TestAgentConfigReviewDisabled(t *testing.T) {
	cfg := AgentConfig{
		MainModel:     "route/kimi-k2.6",
		ReviewModel:   "route/mimo-v2.5-pro",
		ReviewEnabled: false,
	}
	if cfg.ReviewEnabled {
		t.Error("ReviewEnabled should be false")
	}
	// ReviewModel can still be set even if disabled — it's just not used.
	if cfg.ReviewModel != "route/mimo-v2.5-pro" {
		t.Errorf("ReviewModel = %q", cfg.ReviewModel)
	}
}

func TestModelPricing(t *testing.T) {
	p := ModelPricing{
		InputPer1M:  0.45,
		OutputPer1M: 1.00,
		CachePer1M:  0.10,
	}
	if p.InputPer1M != 0.45 {
		t.Errorf("InputPer1M = %f", p.InputPer1M)
	}
	if p.OutputPer1M != 1.00 {
		t.Errorf("OutputPer1M = %f", p.OutputPer1M)
	}
}

func TestSupportConfigHasAgent(t *testing.T) {
	cfg := SupportConfig{
		Agent: AgentConfig{
			MainModel: "test-model",
			MaxTurns:  10,
		},
	}
	if cfg.Agent.MainModel != "test-model" {
		t.Error("Agent.MainModel not set")
	}
	if cfg.Agent.MaxTurns != 10 {
		t.Error("Agent.MaxTurns not set")
	}
}

func TestSupportConfigHasNoAgentsSlice(t *testing.T) {
	cfg := SupportConfig{}
	// The Agents slice field no longer exists — verify the struct compiles without it.
	// Just test that a SupportConfig can be created without error.
	if cfg.Agent.MainModel != "" {
		t.Error("zero-value MainModel should be empty")
	}
}
