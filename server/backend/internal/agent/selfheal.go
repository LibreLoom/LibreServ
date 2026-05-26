package agent

import (
	"context"
	"log/slog"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/conversation"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/tools"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/subscription"

	"github.com/moby/moby/api/types/container"
)

type SelfHealingMonitor struct {
	db           *database.DB
	dockerClient *docker.Client
	provider     *Provider
	convStore    *conversation.Store
	creditSvc    *subscription.CreditService
	checker      *subscription.Checker
	interval     time.Duration
	stopCh       chan struct{}
}

func NewSelfHealingMonitor(dockerClient *docker.Client, db *database.DB) *SelfHealingMonitor {
	m := &SelfHealingMonitor{
		db:           db,
		dockerClient: dockerClient,
		interval:     5 * time.Minute,
		stopCh:       make(chan struct{}),
	}
	if db != nil {
		m.creditSvc = subscription.NewCreditService(db)
		m.checker = subscription.NewChecker(db)
		m.convStore = conversation.NewStore(db)
	}
	m.provider = NewSharedProviderFromConfig()
	return m
}

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
	if m.dockerClient == nil {
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

	containers, err := m.dockerClient.ListContainersAll(ctx)
	if err != nil {
		slog.Error("self-healing: failed to list containers", "error", err)
		return
	}

	var unhealthy []string
	for _, c := range containers {
		if c.Health != nil && c.Health.Status == container.Unhealthy {
			unhealthy = append(unhealthy, c.ID)
		} else if c.State == container.StateExited || c.State == container.StateDead {
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
	agentDef := config.AgentByID("self-healing")
	if agentDef == nil {
		slog.Error("self-healing: no agent definition found for 'self-healing'")
		return
	}

	convID := conversation.GenerateID()
	now := time.Now()
	model := agentDef.Model
	if model == "" {
		model = cfg.Support.DefaultModel
	}
	if model == "" {
		slog.Error("self-healing: no model configured for agent and no default model set")
		return
	}
	conv := &conversation.Conversation{
		ID:             convID,
		UserID:         "system",
		Status:         "active",
		TriggerType:    "self_healing",
		TriggerAppID:   containerID,
		PermissionMode: agentDef.PermissionMode,
		Model:          model,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if conv.PermissionMode == "" {
		conv.PermissionMode = "auto"
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

	registry := tools.RegistryFromAgentDef(*agentDef, tools.ToolDeps{
		DockerClient: m.dockerClient,
	})

	maxTurns := agentDef.MaxTurns
	if maxTurns == 0 {
		maxTurns = 5
	}
	systemPrompt := agentDef.SystemPrompt
	if systemPrompt == "" {
		systemPrompt = buildSelfHealingPrompt()
	}

	agentInst := NewAgent("self-healing", model, "", "", systemPrompt, m.provider)
	loopConfig := LoopConfig{
		MaxTurns:             maxTurns,
		TurnTimeout:          2 * time.Minute,
		PermissionMode:       agentDef.PermissionMode,
		SnapshotBeforeWrites: cfg.Support.Agent.SnapshotBeforeWrites,
		MaxContextMessages:   30,
	}

	loop := NewLoop([]*Agent{agentInst}, registry, m.creditSvc, plan, loopConfig, cfg.Support.BillingMode, "system", convID)

	go func() {
		eventsCh := loop.Events()
		done := make(chan struct{})
		go func() {
			defer close(done)
			for range eventsCh {
			}
		}()
		loop.MarkConsumerReady()
		loop.Run(ctx, "A container ("+containerID+") appears unhealthy or has stopped. Please check its status and attempt to restart it. If it fails again, investigate the logs and explain the problem in plain language.")
		<-done
		if err := m.convStore.UpdateStatus(ctx, convID, "resolved"); err != nil {
			slog.Error("self-healing: failed to resolve conversation", "conv_id", convID, "error", err)
		}
	}()
}

func buildSelfHealingPrompt() string {
	return `You are the LibreServ Self-Healing Agent, an automated assistant that detects and fixes common server problems. When a container is unhealthy or stopped, you: 1) Check its status and recent logs, 2) Attempt to restart it, 3) If it fails, investigate the logs and explain the problem. You operate automatically — the user is not watching. Keep your responses concise and actionable. Never expose raw technical details. If you cannot fix the problem, state clearly what the user should do.`
}
