package subscription

import (
	"testing"
)

func TestPlanByIDWithDefaults(t *testing.T) {
	tests := []struct {
		id       string
		wantName string
	}{
		{"free", "Free"},
		{"basic", "Basic Support"},
		{"premium", "Premium Support"},
	}

	for _, tc := range tests {
		p := PlanByID(tc.id)
		if p == nil {
			t.Fatalf("PlanByID(%q) returned nil", tc.id)
		}
		if p.Name != tc.wantName {
			t.Errorf("PlanByID(%q).Name = %q, want %q", tc.id, p.Name, tc.wantName)
		}
	}
}

func TestPlanByIDNonexistent(t *testing.T) {
	p := PlanByID("nonexistent")
	if p != nil {
		t.Errorf("PlanByID(%q) should return nil for unknown plan, got %v", "nonexistent", p)
	}
}

func TestDefaultPlan(t *testing.T) {
	p := DefaultPlan()
	if p == nil {
		t.Fatal("DefaultPlan() returned nil")
	}
	if p.ID != "free" {
		t.Errorf("DefaultPlan().ID = %q, want %q", p.ID, "free")
	}
}

func TestErrCreditExceeded(t *testing.T) {
	if ErrCreditExceeded == nil {
		t.Fatal("ErrCreditExceeded should not be nil")
	}
	if ErrCreditExceeded.Error() != "credit limit exceeded for current billing period" {
		t.Errorf("ErrCreditExceeded.Error() = %q, want %q", ErrCreditExceeded.Error(), "credit limit exceeded for current billing period")
	}
}

func TestPlansReturnsDefaults(t *testing.T) {
	plans := Plans()
	if len(plans) == 0 {
		t.Fatal("Plans() returned empty slice")
	}
	if plans[0].ID != "free" {
		t.Errorf("Plans()[0].ID = %q, want %q", plans[0].ID, "free")
	}
}
