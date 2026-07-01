package auth

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// newSetupService builds an auth.Service wired with a fresh DB and the TOTP
// encryption key, so a test can drive the same TOTP enrollment flow the setup
// wizard's MFA step uses.
func newSetupService(t *testing.T) *Service {
	t.Helper()
	svc := NewService(newTestDB(t), "testsecret", slog.Default())
	svc.SetMFATOTPEncryptionKey("test-totp-encryption-key-32bytes!!")
	return svc
}

// enrollTOTP enables a TOTP method for the user, mirroring what the setup
// wizard's MFA step does on "Verify & enable".
func enrollTOTP(t *testing.T, svc *Service, ctx context.Context, userID, username string) {
	t.Helper()
	secret, _, _, err := svc.SetupTOTP(ctx, userID, username, "")
	if err != nil {
		t.Fatalf("SetupTOTP: %v", err)
	}
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	if err := svc.VerifyTOTP(ctx, userID, code); err != nil {
		t.Fatalf("VerifyTOTP: %v", err)
	}
}

// TestGetSetupStatus_NotCompleteWhenAdminHasNoMFA is the core regression guard
// for the mid-wizard MfaBlocker bug. The admin account is created at the
// ACCOUNT step, but the wizard then runs REMOTE_ACCESS, SMTP, and the MFA
// enrollment step. GetSetupStatus (consumed by /setup/status +
// reconcileSetupState) must NOT report complete until the admin has an enabled
// MFA method — otherwise a refresh during those later steps makes
// reconcileSetupState MarkComplete the setup state, the frontend navigates to
// "/", and RequireAuth renders the general MfaBlocker instead of resuming the
// wizard's MFA step.
func TestGetSetupStatus_NotCompleteWhenAdminHasNoMFA(t *testing.T) {
	ctx := context.Background()
	svc := newSetupService(t)

	// No users at all → not complete.
	st, err := svc.GetSetupStatus(ctx)
	if err != nil {
		t.Fatalf("GetSetupStatus (empty): %v", err)
	}
	if st.SetupComplete {
		t.Fatal("SetupComplete = true with no users, want false")
	}

	// Create the admin (ACCOUNT step done) but no MFA yet → still NOT complete.
	if _, err := svc.CompleteSetup(ctx, &SetupRequest{
		AdminUsername: "admin",
		AdminPassword: "Superstrongpass123",
		AdminEmail:    "admin@example.com",
	}); err != nil {
		t.Fatalf("CompleteSetup: %v", err)
	}
	st, err = svc.GetSetupStatus(ctx)
	if err != nil {
		t.Fatalf("GetSetupStatus (admin, no mfa): %v", err)
	}
	if st.SetupComplete {
		t.Fatal("SetupComplete = true after admin created but before MFA, want false (mid-wizard)")
	}

	// Enroll MFA (MFA step done) → NOW complete.
	admin, err := svc.GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	enrollTOTP(t, svc, ctx, admin.ID, admin.Username)
	st, err = svc.GetSetupStatus(ctx)
	if err != nil {
		t.Fatalf("GetSetupStatus (admin, with mfa): %v", err)
	}
	if !st.SetupComplete {
		t.Fatal("SetupComplete = false after admin enrolled MFA, want true")
	}
}

// TestIsSetupComplete_StillPermissiveForMFAGuard documents the intentional
// asymmetry: IsSetupComplete (used by RequireSetupComplete to gate /auth/mfa/*
// enrollment) must stay permissive (UserCount>0) even when the admin has no
// MFA. If it required MFA, the wizard's own MFA step would 403 itself into a
// deadlock — the no-MFA admin could never call /auth/mfa/totp/setup. This is
// the counterpart to TestGetSetupStatus_NotCompleteWhenAdminHasNoMFA and must
// not be "fixed" by unifying the two functions.
func TestIsSetupComplete_StillPermissiveForMFAGuard(t *testing.T) {
	ctx := context.Background()
	svc := newSetupService(t)

	if _, err := svc.CompleteSetup(ctx, &SetupRequest{
		AdminUsername: "admin",
		AdminPassword: "Superstrongpass123",
		AdminEmail:    "admin@example.com",
	}); err != nil {
		t.Fatalf("CompleteSetup: %v", err)
	}

	complete, err := svc.IsSetupComplete(ctx)
	if err != nil {
		t.Fatalf("IsSetupComplete: %v", err)
	}
	if !complete {
		t.Fatal("IsSetupComplete = false with an admin but no MFA, want true (must stay permissive so /auth/mfa/* enrollment is reachable mid-wizard)")
	}
}
