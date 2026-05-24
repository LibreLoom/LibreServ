package subscription

import (
	"context"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func setupCheckerTestDB(t *testing.T) *database.DB {
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

func TestSubscriptionDefault(t *testing.T) {
	db := setupCheckerTestDB(t)
	checker := NewChecker(db)

	sub, err := checker.Subscription(context.Background(), "nonexistent_user")
	if err != nil {
		t.Fatalf("Subscription: %v", err)
	}
	if sub.PlanID != "free" {
		t.Errorf("default PlanID = %q, want %q", sub.PlanID, "free")
	}
}

func seedCheckerUser(t *testing.T, db *database.DB, userID string) {
	t.Helper()
	_, err := db.ExecContext(context.Background(), `
		INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		VALUES (?, ?, 'hash', 'user', datetime('now'), datetime('now'))
	`, userID, userID)
	if err != nil {
		t.Fatalf("seed user %s: %v", userID, err)
	}
}

func TestSetPlan(t *testing.T) {
	db := setupCheckerTestDB(t)
	checker := NewChecker(db)
	seedCheckerUser(t, db, "user1")

	err := checker.SetPlan(context.Background(), "user1", "basic", "")
	if err != nil {
		t.Fatalf("SetPlan: %v", err)
	}

	sub, err := checker.Subscription(context.Background(), "user1")
	if err != nil {
		t.Fatalf("Subscription after SetPlan: %v", err)
	}
	if sub.PlanID != "basic" {
		t.Errorf("PlanID after SetPlan = %q, want %q", sub.PlanID, "basic")
	}
}

func TestSetPlanUpgrade(t *testing.T) {
	db := setupCheckerTestDB(t)
	checker := NewChecker(db)
	seedCheckerUser(t, db, "user1")

	_ = checker.SetPlan(context.Background(), "user1", "basic", "")
	err := checker.SetPlan(context.Background(), "user1", "premium", "server-token")
	if err != nil {
		t.Fatalf("SetPlan upgrade: %v", err)
	}

	sub, _ := checker.Subscription(context.Background(), "user1")
	if sub.PlanID != "premium" {
		t.Errorf("PlanID after upgrade = %q, want %q", sub.PlanID, "premium")
	}
}

func TestPlanForUserDefault(t *testing.T) {
	db := setupCheckerTestDB(t)
	checker := NewChecker(db)

	plan := checker.PlanForUser(context.Background(), "nonexistent")
	if plan.ID != "free" {
		t.Errorf("PlanForUser default = %q, want %q", plan.ID, "free")
	}
}

func TestPlanForUserWithPlan(t *testing.T) {
	db := setupCheckerTestDB(t)
	checker := NewChecker(db)
	seedCheckerUser(t, db, "user1")

	_ = checker.SetPlan(context.Background(), "user1", "basic", "")
	plan := checker.PlanForUser(context.Background(), "user1")
	if plan.ID != "basic" {
		t.Errorf("PlanForUser = %q, want %q", plan.ID, "basic")
	}
	if plan.CreditCapUSD != 10.0 {
		t.Errorf("CreditCapUSD = %f, want 10.0", plan.CreditCapUSD)
	}
}

func TestValidateRemotePlanNoServerURL(t *testing.T) {
	db := setupCheckerTestDB(t)
	checker := NewChecker(db)

	_, err := checker.ValidateRemotePlan(context.Background(), "user1")
	if err == nil {
		t.Error("expected error when server URL not configured")
	}
}

func TestRemotePlanValidationStruct(t *testing.T) {
	v := &RemotePlanValidation{Valid: true, PlanID: "basic", PlanName: "Basic Support"}
	if !v.Valid {
		t.Error("Valid should be true")
	}
	if v.PlanID != "basic" {
		t.Errorf("PlanID = %q, want %q", v.PlanID, "basic")
	}
}
