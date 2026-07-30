package billing

import (
	"database/sql"
	"fmt"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// Service provides billing, credit, and usage operations.
type Service struct {
	db *sql.DB
}

// NewService creates a billing service.
func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

// DB returns the underlying database connection (used by webhook handlers).
func (s *Service) DB() *sql.DB {
	return s.db
}

// EnsureAccountCredits creates a zero-balance credit account for a device if none exists.
func (s *Service) EnsureAccountCredits(deviceID string) error {
	_, err := s.db.Exec(
		`INSERT INTO account_credits (id, device_id, balance_cents) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`,
		security.GenerateID("cred"), deviceID)
	return err
}

// GetBalance returns the credit balance in cents for a device.
func (s *Service) GetBalance(deviceID string) (int, error) {
	if err := s.EnsureAccountCredits(deviceID); err != nil {
		return 0, err
	}
	var balance int
	err := s.db.QueryRow(
		"SELECT balance_cents FROM account_credits WHERE device_id = $1", deviceID).Scan(&balance)
	return balance, err
}

// AddCredit adds credit to a device's account and records the transaction.
func (s *Service) AddCredit(deviceID string, amountCents int, reason, referenceID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := s.EnsureAccountCredits(deviceID); err != nil {
		return err
	}

	_, err = tx.Exec(
		`UPDATE account_credits SET balance_cents = balance_cents + $1, updated_at = $2 WHERE device_id = $3`,
		amountCents, time.Now(), deviceID)
	if err != nil {
		return err
	}

	_, err = tx.Exec(
		`INSERT INTO credit_transactions (device_id, amount_cents, direction, reason, reference_id) VALUES ($1, $2, 'credit', $3, $4)`,
		deviceID, amountCents, reason, referenceID)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// DeductCredit subtracts credit and records the transaction. Returns error if insufficient balance.
func (s *Service) DeductCredit(deviceID string, amountCents int, reason, referenceID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var balance int
	err = tx.QueryRow(
		"SELECT balance_cents FROM account_credits WHERE device_id = $1", deviceID).Scan(&balance)
	if err != nil {
		return err
	}

	if balance < amountCents {
		return fmt.Errorf("insufficient credit: have %d cents, need %d", balance, amountCents)
	}

	_, err = tx.Exec(
		`UPDATE account_credits SET balance_cents = balance_cents - $1, updated_at = $2 WHERE device_id = $3`,
		amountCents, time.Now(), deviceID)
	if err != nil {
		return err
	}

	_, err = tx.Exec(
		`INSERT INTO credit_transactions (device_id, amount_cents, direction, reason, reference_id) VALUES ($1, $2, 'debit', $3, $4)`,
		deviceID, amountCents, reason, referenceID)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// RecordUsage inserts a usage event with cost breakdown.
func (s *Service) RecordUsage(deviceID, planID, serviceType, metric string, value, costUSD, providerCost float64) error {
	creditsConsumed := costUSD * 100 // 1 USD = 100 credits (1 credit = 1 cent)
	_, err := s.db.Exec(
		`INSERT INTO usage_events (device_id, plan_id, service_type, metric, value, cost_usd, credits_consumed, provider_cost)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		deviceID, planID, serviceType, metric, value, costUSD, creditsConsumed, providerCost)
	return err
}

// UsageSummary holds aggregated usage for a billing cycle.
type UsageSummary struct {
	DeviceID        string                  `json:"device_id"`
	PlanID          string                  `json:"plan_id"`
	TotalCostUSD    float64                 `json:"total_cost_usd"`
	ProviderCostUSD float64                 `json:"provider_cost_usd"`
	CreditsUsed     float64                 `json:"credits_used"`
	CycleStart      string                  `json:"cycle_start"`
	CycleEnd        string                  `json:"cycle_end"`
	ByService       map[string]ServiceUsage `json:"by_service"`
}

// ServiceUsage is per-service usage within a cycle.
type ServiceUsage struct {
	Value       float64 `json:"value"`
	CostUSD     float64 `json:"cost_usd"`
	CreditsUsed float64 `json:"credits_used"`
}

// GetUsageSummary returns aggregated usage for the current billing cycle.
func (s *Service) GetUsageSummary(deviceID string) (*UsageSummary, error) {
	var planID string
	err := s.db.QueryRow("SELECT plan_id FROM devices WHERE id = $1", deviceID).Scan(&planID)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	cycleStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	cycleEnd := cycleStart.AddDate(0, 1, -1)

	summary := &UsageSummary{
		DeviceID:   deviceID,
		PlanID:     planID,
		CycleStart: cycleStart.Format(time.RFC3339),
		CycleEnd:   cycleEnd.Format(time.RFC3339),
		ByService:  make(map[string]ServiceUsage),
	}

	rows, err := s.db.Query(
		`SELECT service_type, SUM(value), SUM(cost_usd), SUM(credits_consumed), SUM(provider_cost)
		 FROM usage_events
		 WHERE device_id = $1 AND timestamp >= $2
		 GROUP BY service_type`,
		deviceID, cycleStart)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var svc string
		var value, cost, credits, providerCost float64
		if err := rows.Scan(&svc, &value, &cost, &credits, &providerCost); err != nil {
			return nil, err
		}
		summary.ByService[svc] = ServiceUsage{Value: value, CostUSD: cost, CreditsUsed: credits}
		summary.TotalCostUSD += cost
		summary.ProviderCostUSD += providerCost
		summary.CreditsUsed += credits
	}

	return summary, nil
}

// GetDeviceUsageForAdmin returns usage summary for admin view.
func (s *Service) GetDeviceUsageForAdmin(deviceID string) (*UsageSummary, error) {
	return s.GetUsageSummary(deviceID)
}

// GetAggregatedUsage returns total usage across all devices for admin dashboard.
func (s *Service) GetAggregatedUsage() (map[string]float64, error) {
	now := time.Now()
	cycleStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())

	rows, err := s.db.Query(
		`SELECT service_type, SUM(cost_usd), SUM(provider_cost), SUM(credits_consumed)
		 FROM usage_events
		 WHERE timestamp >= $1
		 GROUP BY service_type`,
		cycleStart)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]float64)
	for rows.Next() {
		var svc string
		var cost, providerCost, credits float64
		if err := rows.Scan(&svc, &cost, &providerCost, &credits); err != nil {
			return nil, err
		}
		result[svc+"_cost"] += cost
		result[svc+"_provider_cost"] += providerCost
		result[svc+"_credits"] += credits
		result["total_cost"] += cost
	}

	return result, nil
}

// CreateInvoice creates an invoice record for a billing period.
func (s *Service) CreateInvoice(deviceID string, amountCents int, periodStart, periodEnd time.Time, stripeInvoiceID string) error {
	_, err := s.db.Exec(
		`INSERT INTO invoices (id, device_id, stripe_invoice_id, status, amount_cents, period_start, period_end)
		 VALUES ($1, $2, $3, 'open', $4, $5, $6)`,
		security.GenerateID("inv"), deviceID, stripeInvoiceID, amountCents, periodStart, periodEnd)
	return err
}

// CheckQuota checks if a device has remaining quota for a service.
// Returns remaining allowance and whether usage is within limits.
func (s *Service) CheckQuota(deviceID, serviceType string, requested float64) (remaining float64, allowed bool, err error) {
	var planID string
	err = s.db.QueryRow("SELECT plan_id FROM devices WHERE id = $1", deviceID).Scan(&planID)
	if err != nil {
		return 0, false, err
	}

	plan := catalog.PlanByID(planID)
	if plan == nil {
		return 0, false, fmt.Errorf("unknown plan: %s", planID)
	}

	now := time.Now()
	cycleStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())

	var used float64
	var metric string
	var limit float64

	switch serviceType {
	case "backup":
		metric = "gb"
		limit = float64(plan.Limits.BackupGB)
	case "smtp":
		metric = "emails"
		limit = float64(plan.Limits.SMTPMonthly)
	case "ai":
		// AI is credit-based for paid plans (AICreditCents > 0) with no message cap.
		// Only free tier enforces a daily message limit.
		if plan.Limits.AICreditCents > 0 {
			return 0, true, nil // credit-based plan — no quota gate
		}
		metric = "messages"
		limit = float64(plan.Limits.AIMessagesPerDay)
		// AI is per-day for free tier
		if planID == "free" {
			cycleStart = now.AddDate(0, 0, -1)
		}
	default:
		return 0, true, nil // no quota for unknown services
	}

	err = s.db.QueryRow(
		`SELECT COALESCE(SUM(value), 0) FROM usage_events WHERE device_id = $1 AND service_type = $2 AND metric = $3 AND timestamp >= $4`,
		deviceID, serviceType, metric, cycleStart).Scan(&used)
	if err != nil {
		return 0, false, err
	}

	remaining = limit - used
	allowed = remaining >= requested
	return remaining, allowed, nil
}
