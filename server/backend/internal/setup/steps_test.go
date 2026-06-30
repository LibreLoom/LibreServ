package setup

import (
	"context"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// TestIsValidMainStep_IncludesMfa guards against the regression where the
// frontend's "mfa" setup step was rejected by the backend whitelist, causing
// every advance from the account step to fail with an opaque
// "Failed to save progress" error.
func TestIsValidMainStep_IncludesMfa(t *testing.T) {
	for _, step := range []string{
		StepWelcome, StepPreflight, StepAccount, StepMfa,
		StepRemoteAccess, StepSMTP, StepComplete,
	} {
		if !IsValidMainStep(step) {
			t.Errorf("IsValidMainStep(%q) = false, want true", step)
		}
	}
	if IsValidMainStep("totally_bogus") {
		t.Error(`IsValidMainStep("totally_bogus") = true, want false`)
	}
}

func TestValidateStepData_AllowsMfaCompleted(t *testing.T) {
	if !ValidateStepData(map[string]interface{}{"mfa_completed": true}) {
		t.Error(`ValidateStepData({"mfa_completed": true}) = false, want true`)
	}
	if !ValidateStepData(map[string]interface{}{"account_completed": true, "mfa_completed": true}) {
		t.Error("ValidateStepData with account_completed + mfa_completed = false, want true")
	}
	if ValidateStepData(map[string]interface{}{"unknown_field": true}) {
		t.Error(`ValidateStepData({"unknown_field": true}) = true, want false`)
	}
}

// TestSaveProgress_MfaStepRoundTrip exercises the full path the setup wizard
// hits when handleAccountSuccess advances to the MFA step: the backend must
// accept current_step="mfa" and persist mfa_completed in step_data.
func TestSaveProgress_MfaStepRoundTrip(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	svc := NewService(db)
	ctx := context.Background()
	if _, err := svc.Ensure(ctx); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	stepData := map[string]interface{}{
		"account_completed": true,
		"admin_email":       "admin@example.com",
		"mfa_completed":     true,
	}
	if err := svc.SaveProgress(ctx, StepMfa, "", stepData); err != nil {
		t.Fatalf("SaveProgress(mfa): %v", err)
	}

	state, err := svc.Get(ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if state.CurrentStep != StepMfa {
		t.Errorf("CurrentStep = %q, want %q", state.CurrentStep, StepMfa)
	}
	if got, ok := state.StepData["mfa_completed"].(bool); !ok || !got {
		t.Errorf("StepData[mfa_completed] = %v, want true", state.StepData["mfa_completed"])
	}
}
