package catalog

import (
	"encoding/json"
	"testing"
)

func TestPlanCatalog(t *testing.T) {
	got := Plans()
	if len(got) != 3 {
		t.Fatalf("Plans count = %d", len(got))
	}
	for _, id := range []string{"free", "lite", "one"} {
		plan := PlanByID(id)
		if plan == nil || PlanName(id) != plan.Name {
			t.Fatalf("plan %q not resolved", id)
		}
		var limits Limits
		if err := json.Unmarshal([]byte(plan.Limits.JSON()), &limits); err != nil {
			t.Fatalf("limits JSON for %q: %v", id, err)
		}
	}
	if PlanByID("missing") != nil || PlanName("missing") != "Connect Free" {
		t.Fatal("unknown plan fallback is incorrect")
	}
}

func TestPaidAndSupportPlans(t *testing.T) {
	tests := []struct {
		id      string
		paid    bool
		support bool
	}{
		{"free", false, false},
		{"lite", true, true},
		{"one", true, true},
		{"missing", false, false},
	}
	for _, tt := range tests {
		if got := IsPaidPlan(tt.id); got != tt.paid {
			t.Errorf("IsPaidPlan(%q) = %v", tt.id, got)
		}
		if got := HasHumanSupport(tt.id); got != tt.support {
			t.Errorf("HasHumanSupport(%q) = %v", tt.id, got)
		}
	}
}
