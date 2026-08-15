package handlers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
)

// newRateLimitMFAHandler builds a real auth.Service with an MFA-enabled user
// (TOTP + email) and returns the handler + svc + a valid mfa_token obtained
// through the real login flow, so the limits exercise the true seam.
func newRateLimitMFAHandler(t *testing.T) (*MFAHandler, *auth.Service, string) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	svc := auth.NewService(db, "test-jwt-secret-not-used-in-these-tests", slog.Default())
	svc.SetMFATOTPEncryptionKey("test-totp-encryption-key-32bytes!!")
	ctx := context.Background()
	user, err := svc.Register(ctx, &auth.RegisterRequest{
		Username: "alice",
		Password: "Password12345",
		Email:    "alice@example.com",
	})
	if err != nil {
		t.Fatalf("register user: %v", err)
	}

	// Enable TOTP so login returns an mfa_token.
	secret, _, _, err := svc.SetupTOTP(ctx, user.ID, user.Username, "")
	if err != nil {
		t.Fatalf("SetupTOTP: %v", err)
	}
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	if err := svc.VerifyTOTP(ctx, user.ID, code); err != nil {
		t.Fatalf("VerifyTOTP: %v", err)
	}

	// Enable email MFA: capture the setup OTP and verify it.
	var setupCode string
	if _, err := svc.SetupEmail(ctx, user.ID, "Email", func(email, code string) error {
		setupCode = code
		return nil
	}); err != nil {
		t.Fatalf("SetupEmail: %v", err)
	}
	if err := svc.VerifyEmailSetup(ctx, user.ID, setupCode); err != nil {
		t.Fatalf("VerifyEmailSetup: %v", err)
	}

	_, err = svc.Login(ctx, &auth.LoginRequest{Username: "alice", Password: "Password12345"})
	var mfaReq *auth.MFARequiredError
	if !errors.As(err, &mfaReq) || mfaReq.MFAToken == "" {
		t.Fatalf("Login: expected MFARequiredError with token, got %v", err)
	}
	return NewMFAHandler(svc, nil), svc, mfaReq.MFAToken
}

func mfaChallengeReq(token, mfaType string) *http.Request {
	return httptest.NewRequest(http.MethodPost, "/api/v1/auth/mfa/challenge",
		strings.NewReader(fmt.Sprintf(`{"mfa_token":%q,"type":%q}`, token, mfaType)))
}

func mfaVerifyReq(token, mfaType, code string) *http.Request {
	return httptest.NewRequest(http.MethodPost, "/api/v1/auth/mfa/verify",
		strings.NewReader(fmt.Sprintf(`{"mfa_token":%q,"type":%q,"payload":{"code":%q}}`, token, mfaType, code)))
}

func mfaRecoverReq(token, code string) *http.Request {
	return httptest.NewRequest(http.MethodPost, "/api/v1/auth/mfa/recover",
		strings.NewReader(fmt.Sprintf(`{"mfa_token":%q,"recovery_code":%q}`, token, code)))
}

func mustMFATokenUser(t *testing.T, svc *auth.Service, token string) *models.User {
	t.Helper()
	user, err := svc.ValidateMFAToken(context.Background(), token)
	if err != nil {
		t.Fatalf("ValidateMFAToken: %v", err)
	}
	return user
}

func TestChallenge_EmailSendRateLimited(t *testing.T) {
	h, svc, token := newRateLimitMFAHandler(t)
	sends := 0
	h.SetEmailSender(func(email, code string) error { sends++; return nil })
	user := mustMFATokenUser(t, svc, token)

	// First send is allowed.
	rr := httptest.NewRecorder()
	h.Challenge(rr, mfaChallengeReq(token, "email"))
	if rr.Code != http.StatusOK {
		t.Fatalf("first send: status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}

	// An immediate second send hits the 30s resend cooldown and must NOT send
	// another code.
	rr2 := httptest.NewRecorder()
	h.Challenge(rr2, mfaChallengeReq(token, "email"))
	if rr2.Code != http.StatusTooManyRequests {
		t.Fatalf("immediate resend: status = %d, want 429; body=%s", rr2.Code, rr2.Body.String())
	}
	if rr2.Header().Get("Retry-After") == "" {
		t.Fatal("resend rejection missing Retry-After header")
	}
	if sends != 1 {
		t.Fatalf("email sends = %d, want 1 (no code sent while on cooldown)", sends)
	}

	// Seed the send history (sends spaced ≥30s apart inside the last minute)
	// to exercise the per-minute budget without sleeping: three sends fill it.
	now := time.Now()
	h.emailRateLimit.Store(user.ID, []time.Time{
		now.Add(-50 * time.Second),
		now.Add(-40 * time.Second),
		now.Add(-30 * time.Second),
	})
	rr3 := httptest.NewRecorder()
	h.Challenge(rr3, mfaChallengeReq(token, "email"))
	if rr3.Code != http.StatusTooManyRequests {
		t.Fatalf("budget exceeded: status = %d, want 429; body=%s", rr3.Code, rr3.Body.String())
	}
	if sends != 1 {
		t.Fatalf("email sends after budget = %d, want 1", sends)
	}
}

func TestVerify_AttemptsRateLimited(t *testing.T) {
	h, _, token := newRateLimitMFAHandler(t)

	for i := 0; i < mfaVerifyAttempts; i++ {
		rr := httptest.NewRecorder()
		h.Verify(rr, mfaVerifyReq(token, "totp", "000000"))
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401 (wrong code); body=%s", i+1, rr.Code, rr.Body.String())
		}
	}

	// The next attempt is throttled instead of being checked.
	rr := httptest.NewRecorder()
	h.Verify(rr, mfaVerifyReq(token, "totp", "000000"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited verify: status = %d, want 429; body=%s", rr.Code, rr.Body.String())
	}
}

func TestRecover_AttemptsRateLimited(t *testing.T) {
	h, _, token := newRateLimitMFAHandler(t)

	for i := 0; i < mfaRecoverAttempts; i++ {
		rr := httptest.NewRecorder()
		h.Recover(rr, mfaRecoverReq(token, "WRONG-CODE"))
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401 (wrong code); body=%s", i+1, rr.Code, rr.Body.String())
		}
	}

	rr := httptest.NewRecorder()
	h.Recover(rr, mfaRecoverReq(token, "WRONG-CODE"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited recover: status = %d, want 429; body=%s", rr.Code, rr.Body.String())
	}
}
