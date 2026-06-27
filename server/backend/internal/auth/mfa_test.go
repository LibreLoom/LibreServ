package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// newMFAService creates a test DB + auth service with the TOTP encryption key
// set (so TOTP enrollment works).
func newMFAService(t *testing.T) *Service {
	t.Helper()
	svc := NewService(newTestDB(t), "testsecret", slog.Default())
	svc.SetMFATOTPEncryptionKey("test-totp-encryption-key-32bytes!!")
	return svc
}

// totpCode generates a valid current-window TOTP code for a secret.
func totpCode(t *testing.T, secret string) string {
	t.Helper()
	c, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	return c
}

// TestMFAEnforcementAndLoginFlow covers the no-softlock requirements:
// admin-can't-have-no-MFA, can't-delete-last-method, login returns
// mfa_required (not a session), verify pass/fail, recovery works.
func TestMFAEnforcementAndLoginFlow(t *testing.T) {
	ctx := context.Background()
	svc := newMFAService(t)
	user, err := svc.Register(ctx, &RegisterRequest{
		Username: "admin1", Password: "SuperSecret123", Email: "admin1@example.com",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	// Admin without MFA can't be granted admin.
	if err := svc.EnsureAdminMFA(ctx, user.ID); err != ErrMFAAdminRequired {
		t.Fatalf("EnsureAdminMFA (no mfa): expected ErrMFAAdminRequired, got %v", err)
	}

	// TOTP setup + verify (enable).
	secret, _, _, err := svc.SetupTOTP(ctx, user.ID, user.Username, "")
	if err != nil {
		t.Fatalf("SetupTOTP: %v", err)
	}
	code := totpCode(t, secret)
	if code == "" {
		t.Fatalf("GenerateCode: empty")
	}
	if err := svc.VerifyTOTP(ctx, user.ID, code); err != nil {
		t.Fatalf("VerifyTOTP: %v", err)
	}
	has, _ := svc.HasMFA(ctx, user.ID)
	if !has {
		t.Fatalf("HasMFA should be true after enabling")
	}

	// Now admin-required passes.
	if err := svc.EnsureAdminMFA(ctx, user.ID); err != nil {
		t.Fatalf("EnsureAdminMFA (with mfa): expected nil, got %v", err)
	}

	// Login returns MFARequiredError (NOT a session) for an MFA-enabled user.
	_, err = svc.Login(ctx, &LoginRequest{Username: "admin1", Password: "SuperSecret123"})
	var mfaReq *MFARequiredError
	if !errors.As(err, &mfaReq) {
		t.Fatalf("Login: expected MFARequiredError, got %v", err)
	}
	if mfaReq.MFAToken == "" || len(mfaReq.Methods) != 1 {
		t.Fatalf("MFARequiredError: bad mfa_token/methods: %+v", mfaReq)
	}

	// The mfa_token validates + resolves to the user.
	mfaUser, err := svc.ValidateMFAToken(ctx, mfaReq.MFAToken)
	if err != nil || mfaUser.ID != user.ID {
		t.Fatalf("ValidateMFAToken: err=%v user=%+v", err, mfaUser)
	}

	// VerifyMFA with a fresh code → issues a session (TokenPair).
	code2 := totpCode(t, secret)
	tokens, err := svc.VerifyMFA(ctx, user.ID, user.Username, user.Role, MFATypeTOTP,
		[]byte(fmt.Sprintf(`{"code":"%s"}`, code2)), nil)
	if err != nil {
		t.Fatalf("VerifyMFA: %v", err)
	}
	if tokens == nil || tokens.AccessToken == "" {
		t.Fatalf("VerifyMFA: no tokens")
	}

	// Wrong code → error (no session).
	_, err = svc.VerifyMFA(ctx, user.ID, user.Username, user.Role, MFATypeTOTP,
		[]byte(`{"code":"000000"}`), nil)
	if err == nil {
		t.Fatalf("VerifyMMA wrong code: expected error")
	}

	// Can't delete the last enabled method (softlock prevention).
	methods, _ := svc.ListMFAMethods(ctx, user.ID)
	if len(methods) != 1 {
		t.Fatalf("expected 1 method, got %d", len(methods))
	}
	if err := svc.DeleteMFAMethod(ctx, user.ID, methods[0].ID); err != ErrMFALastMethod {
		t.Fatalf("DeleteMFAMethod (last): expected ErrMFALastMethod, got %v", err)
	}

	// Recovery codes: generated once, single-use, hashed at rest.
	codes, err := svc.GenerateRecoveryCodes(ctx, user.ID)
	if err != nil || len(codes) != 10 {
		t.Fatalf("GenerateRecoveryCodes: err=%v len=%d", err, len(codes))
	}
	if err := svc.VerifyRecoveryCode(ctx, user.ID, codes[0]); err != nil {
		t.Fatalf("VerifyRecoveryCode: %v", err)
	}
	// Reused recovery code fails.
	if err := svc.VerifyRecoveryCode(ctx, user.ID, codes[0]); err == nil {
		t.Fatalf("reused recovery code should fail")
	}
	remaining, _ := svc.RecoveryCodesRemaining(ctx, user.ID)
	if remaining != 9 {
		t.Fatalf("remaining: expected 9, got %d", remaining)
	}
}

// TestMFARecoveryFlow verifies the full recover-from-mfa_token login path
// (ValidateMFAToken → VerifyRecoveryCode → session).
func TestMFARecoveryFlow(t *testing.T) {
	ctx := context.Background()
	svc := newMFAService(t)
	user, _ := svc.Register(ctx, &RegisterRequest{
		Username: "admin2", Password: "SuperSecret123", Email: "admin2@example.com",
	})
	secret, _, _, _ := svc.SetupTOTP(ctx, user.ID, user.Username, "")
	if err := svc.VerifyTOTP(ctx, user.ID, totpCode(t, secret)); err != nil {
		t.Fatalf("VerifyTOTP: %v", err)
	}
	_, err := svc.Login(ctx, &LoginRequest{Username: "admin2", Password: "SuperSecret123"})
	var mfaReq *MFARequiredError
	if !errors.As(err, &mfaReq) {
		t.Fatalf("Login: expected MFARequiredError, got %v", err)
	}
	codes, _ := svc.GenerateRecoveryCodes(ctx, user.ID)
	if err := svc.VerifyRecoveryCode(ctx, user.ID, codes[0]); err != nil {
		t.Fatalf("VerifyRecoveryCode: %v", err)
	}
	// Recovery doesn't itself issue a session — the handler calls
	// GenerateTokenPairForUser after a valid recovery. Verify that works.
	tokens, err := svc.GenerateTokenPairForUser(ctx, user.ID)
	if err != nil || tokens.AccessToken == "" {
		t.Fatalf("GenerateTokenPairForUser: err=%v tokens=%+v", err, tokens)
	}
}
