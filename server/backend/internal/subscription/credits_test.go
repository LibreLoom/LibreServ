package subscription

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func setupCreditTestDB(t *testing.T) *database.DB {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func seedCreditUser(t *testing.T, db *database.DB) {
	t.Helper()
	_, err := db.ExecContext(context.Background(), `
		INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		VALUES ('user1', 'testuser', 'hash', 'user', datetime('now'), datetime('now'))
	`)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	_, err = db.ExecContext(context.Background(), `
		INSERT INTO agent_conversations (id, user_id, status, trigger_type, permission_mode, model, created_at, updated_at)
		VALUES ('conv1', 'user1', 'active', 'manual', 'auto', 'route/mimo-v2.5-pro', datetime('now'), datetime('now'))
	`)
	if err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
}

func TestCheckAndDeductBasic(t *testing.T) {
	db := setupCreditTestDB(t)
	svc := NewCreditService(db)
	seedCreditUser(t, db)

	plan := &Plan{ID: "basic", CreditCapUSD: 10.0}

	err := svc.CheckAndDeduct(context.Background(), "user1", "conv1", "route/mimo-v2.5-pro", 1000, 500, 200, 0.002, plan)
	if err != nil {
		t.Fatalf("CheckAndDeduct: %v", err)
	}
}

func TestCheckAndDeductExceedsCap(t *testing.T) {
	db := setupCreditTestDB(t)
	svc := NewCreditService(db)
	seedCreditUser(t, db)

	plan := &Plan{ID: "basic", CreditCapUSD: 0.01}

	err := svc.CheckAndDeduct(context.Background(), "user1", "conv1", "route/mimo-v2.5-pro", 100000, 50000, 0, 5.0, plan)
	if err != ErrCreditExceeded {
		t.Errorf("CheckAndDeduct with high cost = %v, want ErrCreditExceeded", err)
	}
}

func TestCheckAndDeductMultipleDeductions(t *testing.T) {
	db := setupCreditTestDB(t)
	svc := NewCreditService(db)
	seedCreditUser(t, db)

	plan := &Plan{ID: "basic", CreditCapUSD: 10.0}

	for i := 0; i < 5; i++ {
		err := svc.CheckAndDeduct(context.Background(), "user1", "conv1", "route/mimo-v2.5-pro", 100, 50, 0, 0.001, plan)
		if err != nil {
			t.Fatalf("deduction %d: %v", i, err)
		}
	}

	usage, err := svc.Usage(context.Background(), "user1", plan)
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if usage.TotalCostUSD != 0.005 {
		t.Errorf("TotalCostUSD = %f, want 0.005", usage.TotalCostUSD)
	}
}

func TestCheckAndDeductUnlimitedPlan(t *testing.T) {
	db := setupCreditTestDB(t)
	svc := NewCreditService(db)
	seedCreditUser(t, db)

	plan := &Plan{ID: "premium", CreditCapUSD: 0}

	err := svc.CheckAndDeduct(context.Background(), "user1", "conv1", "route/mimo-v2.5-pro", 100000, 50000, 0, 50.0, plan)
	if err != nil {
		t.Fatalf("CheckAndDeduct unlimited: %v", err)
	}
}

func TestBillingCycleStart(t *testing.T) {
	now := time.Date(2026, 5, 23, 10, 0, 0, 0, time.UTC)
	start := billingCycleStart(now)
	if start.Month() != 5 || start.Day() != 1 {
		t.Errorf("billingCycleStart = %v, want 2026-05-01", start)
	}
}

func TestUsageSummary(t *testing.T) {
	db := setupCreditTestDB(t)
	svc := NewCreditService(db)
	seedCreditUser(t, db)

	plan := &Plan{ID: "basic", CreditCapUSD: 10.0}
	_ = svc.CheckAndDeduct(context.Background(), "user1", "conv1", "route/mimo-v2.5-pro", 1000, 500, 0, 0.50, plan)

	usage, err := svc.Usage(context.Background(), "user1", plan)
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if usage.TotalCostUSD != 0.50 {
		t.Errorf("TotalCostUSD = %f, want 0.50", usage.TotalCostUSD)
	}
	if usage.RemainingUSD != 9.50 {
		t.Errorf("RemainingUSD = %f, want 9.50", usage.RemainingUSD)
	}
}

func TestCheckAndDeductRequest(t *testing.T) {
	db := setupCreditTestDB(t)
	svc := NewCreditService(db)
	seedCreditUser(t, db)

	plan := &Plan{ID: "basic", CreditCapUSD: 10.0}

	err := svc.CheckAndDeductRequest(context.Background(), "user1", "conv1", "route/mimo-v2.5-pro", 0.73, plan)
	if err != nil {
		t.Fatalf("CheckAndDeductRequest: %v", err)
	}

	usage, err := svc.Usage(context.Background(), "user1", plan)
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if usage.TotalCostUSD != 0.73 {
		t.Errorf("TotalCostUSD = %f, want 0.73", usage.TotalCostUSD)
	}
}

func TestCheckAndDeductRequestExceedsCap(t *testing.T) {
	db := setupCreditTestDB(t)
	svc := NewCreditService(db)
	seedCreditUser(t, db)

	plan := &Plan{ID: "basic", CreditCapUSD: 0.50}

	err := svc.CheckAndDeductRequest(context.Background(), "user1", "conv1", "route/mimo-v2.5-pro", 1.00, plan)
	if err != ErrCreditExceeded {
		t.Errorf("CheckAndDeductRequest with high cost = %v, want ErrCreditExceeded", err)
	}
}
