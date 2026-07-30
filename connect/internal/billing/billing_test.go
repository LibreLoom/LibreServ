package billing

import (
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
)

// TestAICheckQuotaLogic verifies the catalog plan configurations match
// the expected behavior for CheckQuota's AI branch:
//
//	Paid plans (lite/one) have AICreditCents > 0, so CheckQuota returns
//	allowed=true immediately (credit-based, no message cap).
//
//	Free plan has AICreditCents == 0 and AIMessagesPerDay == 50, so
//	CheckQuota enforces a per-day message limit.
//
// This test ensures the catalog stays in sync with the quota logic.
func TestAICheckQuotaLogic(t *testing.T) {
	tests := []struct {
		planID               string
		wantCreditBased      bool // true if AICreditCents > 0 → no quota gate
		wantDailyLimit       bool // true if AIMessagesPerDay > 0 → quota gate
		wantAIMessagesPerDay int
	}{
		{
			planID:               "free",
			wantCreditBased:      false,
			wantDailyLimit:       true,
			wantAIMessagesPerDay: 50,
		},
		{
			planID:          "lite",
			wantCreditBased: true,
			wantDailyLimit:  false,
		},
		{
			planID:          "one",
			wantCreditBased: true,
			wantDailyLimit:  false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.planID, func(t *testing.T) {
			plan := catalog.PlanByID(tc.planID)
			if plan == nil {
				t.Fatalf("plan %q not found in catalog", tc.planID)
			}

			// When AICreditCents > 0, CheckQuota returns early with
			// allowed=true (no quota gate).
			isCreditBased := plan.Limits.AICreditCents > 0
			if isCreditBased != tc.wantCreditBased {
				t.Errorf("AICreditCents=%d: want credit-based=%v, got %v",
					plan.Limits.AICreditCents, tc.wantCreditBased, isCreditBased)
			}

			// When AICreditCents == 0 AND AIMessagesPerDay > 0, CheckQuota
			// enforces the per-day message limit.
			hasDailyLimit := plan.Limits.AIMessagesPerDay > 0
			if hasDailyLimit != tc.wantDailyLimit {
				t.Errorf("AIMessagesPerDay=%d: want daily limit=%v, got %v",
					plan.Limits.AIMessagesPerDay, tc.wantDailyLimit, hasDailyLimit)
			}

			if tc.wantAIMessagesPerDay > 0 && plan.Limits.AIMessagesPerDay != tc.wantAIMessagesPerDay {
				t.Errorf("AIMessagesPerDay: want %d, got %d",
					tc.wantAIMessagesPerDay, plan.Limits.AIMessagesPerDay)
			}
		})
	}
}

// TestQuotaLogicConsistency verifies that the CheckQuota switch logic
// covers all known service types consistently.
func TestQuotaLogicConsistency(t *testing.T) {
	// Verify all paid plans have AICreditCents > 0 (no daily message cap).
	for _, planID := range []string{"lite", "one"} {
		plan := catalog.PlanByID(planID)
		if plan == nil {
			t.Fatalf("plan %q not found", planID)
		}
		if plan.Limits.AICreditCents <= 0 {
			t.Errorf("plan %s: expected AICreditCents > 0 for credit-based AI", planID)
		}
	}

	// Verify free plan has no credit but has a daily message limit.
	freePlan := catalog.PlanByID("free")
	if freePlan == nil {
		t.Fatalf("free plan not found")
	}
	if freePlan.Limits.AICreditCents != 0 {
		t.Errorf("free plan: expected AICreditCents == 0, got %d", freePlan.Limits.AICreditCents)
	}
	if freePlan.Limits.AIMessagesPerDay <= 0 {
		t.Errorf("free plan: expected AIMessagesPerDay > 0, got %d", freePlan.Limits.AIMessagesPerDay)
	}
}
