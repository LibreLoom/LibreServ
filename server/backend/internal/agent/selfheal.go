package agent

import (
	"context"
	"log/slog"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/conversation"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/tools"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/subscription"
)

// SelfHealingMonitor watches for unhealthy containers and dispatches
// an agent to diagnose and fix them automatically.
type SelfHealingMonitor struct {
	db            *database.DB
	runtimeClient *podman.Client
	provider      *Provider
	convStore     *conversation.Store
	creditSvc     *subscription.CreditService
	checker       *subscription.Checker
	interval      time.Duration
	stopCh        chan struct{}
}

// NewSelfHealingMonitor creates a new monitor.
func NewSelfHealingMonitor(runtimeClient *podman.Client, db *database.DB, connectClient connect.Client) *SelfHealingMonitor {
	m := &SelfHealingMonitor{
		db:            db,
		runtimeClient: runtimeClient,
		interval:      5 * time.Minute,
		stopCh:        make(chan struct{}),
	}
	if db != nil {
		m.creditSvc = subscription.NewCreditService(db)
		m.checker = subscription.NewChecker(db)
		m.convStore = conversation.NewStore(db)
	}
	m.provider = NewAIProvider(context.Background(), connectClient, nil)
	return m
}

// Start begins the monitoring loop.
func (m *SelfHealingMonitor) Start() {
	cfg := config.Get()
	if cfg == nil || !cfg.Support.SelfHealing {
		return
	}

	if m.checker != nil && cfg.Support.Agent.SystemPlanID != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := m.checker.SetPlan(ctx, "system", cfg.Support.Agent.SystemPlanID, ""); err != nil {
			slog.Error("self-healing: failed to seed system subscription", "error", err)
		}
	}

	slog.Info("self-healing monitor started", "interval", m.interval)
	go m.run()
}

// Stop terminates the monitoring loop.
func (m *SelfHealingMonitor) Stop() {
	close(m.stopCh)
}

func (m *SelfHealingMonitor) run() {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	for {
		select {
		case <-m.stopCh:
			return
		case <-ticker.C:
			m.checkAndHeal()
		}
	}
}

func (m *SelfHealingMonitor) checkAndHeal() {
	if m.runtimeClient == nil {
		return
	}
	cfg := config.Get()
	if cfg == nil || !cfg.Support.SelfHealing {
		return
	}
	if cfg.Support.DeviceToken == "" && !(cfg.Support.BYOKEnabled && cfg.Support.UserAPIKey != "") {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	containers, err := m.runtimeClient.ListContainersAll(ctx)
	if err != nil {
		slog.Error("self-healing: failed to list containers", "error", err)
		return
	}

	var unhealthy []string
	for _, c := range containers {
		if c.State == "exited" || c.State == "dead" {
			unhealthy = append(unhealthy, c.ID)
		}
	}

	if len(unhealthy) == 0 {
		return
	}

	slog.Info("self-healing: detected unhealthy containers", "count", len(unhealthy))

	for _, containerID := range unhealthy {
		active, _ := m.convStore.FindActiveByTrigger(ctx, "self_healing", containerID)
		if active != nil {
			slog.Debug("self-healing: skipping container, already being handled", "container_id", containerID, "conv_id", active.ID)
			continue
		}
		m.healContainer(ctx, containerID, cfg)
	}
}

func (m *SelfHealingMonitor) healContainer(ctx context.Context, containerID string, cfg *config.Config) {
	model := cfg.Support.Agent.MainModel
	if model == "" {
		slog.Error("self-healing: no model configured")
		return
	}

	convID := conversation.GenerateID()
	now := time.Now()
	conv := &conversation.Conversation{
		ID:             convID,
		UserID:         "system",
		Status:         "active",
		TriggerType:    "self_healing",
		TriggerAppID:   containerID,
		PermissionMode: "auto",
		Model:          model,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := m.convStore.Create(ctx, conv); err != nil {
		slog.Error("self-healing: failed to create conversation", "error", err)
		return
	}

	plan := m.checker.PlanForUser(ctx, "system")
	if plan.CreditCapUSD == 0 {
		systemPlanID := cfg.Support.Agent.SystemPlanID
		if systemPlanID != "" {
			if p := subscription.PlanByID(systemPlanID); p != nil {
				plan = p
			}
		}
	}

	// Use the standard pi-style tool set. The bash tool runs through the
	// configured OS sandbox like the user-facing agent.
	sb := NewSandbox(cfg.Support.Agent.Sandbox)
	registry := tools.StandardRegistry(sb)

	// Build the review model — self-healing uses it but auto-approves "review" verdicts.
	var reviewModel *ReviewModel
	if cfg.Support.Agent.ReviewEnabled {
		reviewModelID := cfg.Support.Agent.ReviewModel
		if reviewModelID == "" {
			reviewModelID = model
		}
		reviewModel = NewReviewModel(m.provider, reviewModelID)
	}

	systemPrompt := cfg.Support.Agent.SystemPrompt
	if systemPrompt == "" {
		systemPrompt = buildSelfHealingPrompt()
	}

	agentInst := NewAgent("self-healing", model, "", "", systemPrompt, m.provider)

	maxTurns := cfg.Support.Agent.MaxTurns
	if maxTurns <= 0 || maxTurns > 5 {
		maxTurns = 5
	}

	loopConfig := LoopConfig{
		MaxTurns:           maxTurns,
		TurnTimeout:        2 * time.Minute,
		PermissionMode:     "auto", // autonomous: review model decides allow/deny (no human to confirm)
		MaxContextMessages: 30,
		DataDirs:           cfg.Support.Agent.DataDirs,
	}

	loop := NewLoop(agentInst, registry, reviewModel, m.creditSvc, plan, loopConfig, cfg.Support.BillingMode, "system", convID)

	// Give the reviewer session context if a summary model is configured.
	if summaryModelID := cfg.Support.Agent.SummaryModel; summaryModelID != "" {
		loop.SetSessionSummarizer(NewSessionSummarizer(m.provider, summaryModelID))
	}

	go func() {
		eventsCh := loop.Events()
		done := make(chan struct{})
		go func() {
			defer close(done)
			for range eventsCh {
			}
		}()
		loop.MarkConsumerReady()
		loop.Run(ctx, "A container ("+containerID+") appears unhealthy or has stopped. Check its status, try to restart it. If it keeps failing, investigate logs and explain the problem in plain language.")
		<-done
		if err := m.convStore.UpdateStatus(ctx, convID, "resolved"); err != nil {
			slog.Error("self-healing: failed to resolve conversation", "conv_id", convID, "error", err)
		}
	}()
}

func buildSelfHealingPrompt() string {
	return `You are the LibreServ Self-Healing Agent, an automated assistant that detects and fixes common server problems. When a container is unhealthy or stopped, you: 1) Check its status and recent logs, 2) Attempt to restart it, 3) If it fails, investigate the logs and explain the problem. You operate automatically — the user is not watching. Keep your responses concise and actionable. Never expose technical details like model names, tool names, or error codes. If you cannot fix the problem, state clearly what the user should do next.`
}
