package subscription

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type Subscription struct {
	UserID            string     `json:"user_id"`
	PlanID            string     `json:"plan_id"`
	Status            string     `json:"status"`
	BillingCycleStart time.Time  `json:"billing_cycle_start"`
	BillingCycleEnd   *time.Time `json:"billing_cycle_end,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

type Checker struct {
	db *database.DB
}

func NewChecker(db *database.DB) *Checker {
	return &Checker{db: db}
}

func (c *Checker) Subscription(ctx context.Context, userID string) (*Subscription, error) {
	row := c.db.QueryRowContext(ctx, `
		SELECT user_id, plan_id, status, billing_cycle_start, billing_cycle_end, created_at, updated_at
		FROM user_subscriptions
		WHERE user_id = ?
	`, userID)

	var sub Subscription
	var cycleEnd sql.NullTime
	if err := row.Scan(&sub.UserID, &sub.PlanID, &sub.Status, &sub.BillingCycleStart, &cycleEnd, &sub.CreatedAt, &sub.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return &Subscription{UserID: userID, PlanID: "free", Status: "active"}, nil
		}
		return nil, err
	}
	if cycleEnd.Valid {
		sub.BillingCycleEnd = &cycleEnd.Time
	}
	return &sub, nil
}

func (c *Checker) PlanForUser(ctx context.Context, userID string) *Plan {
	sub, err := c.Subscription(ctx, userID)
	if err != nil {
		return DefaultPlan()
	}
	p := PlanByID(sub.PlanID)
	if p == nil {
		return DefaultPlan()
	}
	return p
}

func (c *Checker) SetPlan(ctx context.Context, userID, planID, serverToken string) error {
	_, err := c.db.ExecContext(ctx, `
		INSERT INTO user_subscriptions (user_id, plan_id, status, support_server_token, created_at, updated_at)
		VALUES (?, ?, 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id) DO UPDATE SET plan_id = ?, support_server_token = ?, updated_at = CURRENT_TIMESTAMP
	`, userID, planID, serverToken, planID, serverToken)
	return err
}

type RemotePlanValidation struct {
	Valid    bool   `json:"valid"`
	PlanID   string `json:"plan_id"`
	PlanName string `json:"plan_name"`
	Error    string `json:"error,omitempty"`
}

func (c *Checker) ValidateRemotePlan(ctx context.Context, userID string) (*RemotePlanValidation, error) {
	cfg := config.Get()
	if cfg == nil || cfg.Support.ServerURL == "" {
		return nil, fmt.Errorf("support server URL not configured")
	}

	sub, err := c.Subscription(ctx, userID)
	if err != nil {
		return nil, err
	}

	if sub.PlanID == "free" {
		return &RemotePlanValidation{Valid: true, PlanID: "free", PlanName: "Free"}, nil
	}

	reqURL := fmt.Sprintf("%s/api/v1/subscriptions/%s/validate", cfg.Support.ServerURL, url.PathEscape(userID))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create validation request: %w", err)
	}
	if sub.PlanID != "" {
		req.Header.Set("X-Plan-ID", sub.PlanID)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return &RemotePlanValidation{Valid: false, PlanID: sub.PlanID, Error: "Could not reach the plan validation server. Your subscription details will be checked again later."}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		_, _ = io.ReadAll(resp.Body)
		return &RemotePlanValidation{
			Valid:  false,
			PlanID: sub.PlanID,
			Error:  fmt.Sprintf("Plan validation returned an unexpected response. Please try again later or contact support."),
		}, nil
	}

	var result RemotePlanValidation
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return &RemotePlanValidation{Valid: false, PlanID: sub.PlanID, Error: "Could not understand the validation response."}, nil
	}
	return &result, nil
}
