package subscription

import (
	"context"
	"fmt"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type CreditService struct {
	db *database.DB
	mu sync.Mutex
}

func NewCreditService(db *database.DB) *CreditService {
	return &CreditService{db: db}
}

type UsageSummary struct {
	TotalCostUSD float64 `json:"total_cost_usd"`
	CreditCapUSD float64 `json:"credit_cap_usd"`
	RemainingUSD float64 `json:"remaining_usd"`
	PlanID       string  `json:"plan_id"`
}

func (s *CreditService) CheckAndDeduct(ctx context.Context, userID, conversationID, model string, inputTokens, outputTokens, cacheTokens int, costUSD float64, plan *Plan) error {
	return s.checkAndDeduct(ctx, userID, conversationID, model, inputTokens, outputTokens, cacheTokens, costUSD, plan)
}

func (s *CreditService) CheckAndDeductRequest(ctx context.Context, userID, conversationID, model string, costPerRequest float64, plan *Plan) error {
	return s.checkAndDeduct(ctx, userID, conversationID, model, 0, 0, 0, costPerRequest, plan)
}

func (s *CreditService) checkAndDeduct(ctx context.Context, userID, conversationID, model string, inputTokens, outputTokens, cacheTokens int, costUSD float64, plan *Plan) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	conn, err := s.db.SQL().Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("begin immediate: %w", err)
	}

	committed := false
	defer func() {
		if !committed {
			conn.ExecContext(ctx, "ROLLBACK")
		}
	}()

	var used float64
	row := conn.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(cost_usd), 0)
		FROM credit_usage
		WHERE user_id = ? AND created_at >= ?
	`, userID, billingCycleStart(time.Now()))
	if err := row.Scan(&used); err != nil {
		return fmt.Errorf("query credit usage: %w", err)
	}

	if plan != nil && plan.CreditCapUSD > 0 && used+costUSD > plan.CreditCapUSD {
		return ErrCreditExceeded
	}

	id := generateID()
	_, err = conn.ExecContext(ctx, `
		INSERT INTO credit_usage (id, user_id, conversation_id, model, input_tokens, output_tokens, cache_tokens, cost_usd, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, id, userID, conversationID, model, inputTokens, outputTokens, cacheTokens, costUSD, time.Now())
	if err != nil {
		return fmt.Errorf("insert credit usage: %w", err)
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("commit credit transaction: %w", err)
	}
	committed = true
	return nil
}

func (s *CreditService) Usage(ctx context.Context, userID string, plan *Plan) (*UsageSummary, error) {
	var used float64
	row := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(cost_usd), 0)
		FROM credit_usage
		WHERE user_id = ? AND created_at >= ?
	`, userID, billingCycleStart(time.Now()))
	if err := row.Scan(&used); err != nil {
		return nil, fmt.Errorf("query credit usage: %w", err)
	}

	capUSD := 0.0
	planID := "free"
	if plan != nil {
		capUSD = plan.CreditCapUSD
		planID = plan.ID
	}

	remaining := capUSD - used
	if remaining < 0 {
		remaining = 0
	}

	return &UsageSummary{
		TotalCostUSD: used,
		CreditCapUSD: capUSD,
		RemainingUSD: remaining,
		PlanID:       planID,
	}, nil
}

func billingCycleStart(now time.Time) time.Time {
	y, m, _ := now.Date()
	return time.Date(y, m, 1, 0, 0, 0, 0, now.Location())
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
