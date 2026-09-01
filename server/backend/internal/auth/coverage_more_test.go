package auth

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
)

type coverageWebAuthnVerifier struct{}

func (coverageWebAuthnVerifier) BeginRegistration(context.Context, string, string, string, WebAuthnAttachment) (json.RawMessage, error) {
	return nil, nil
}
func (coverageWebAuthnVerifier) FinishRegistration(context.Context, string, json.RawMessage) (WebAuthnCredential, error) {
	return WebAuthnCredential{}, nil
}
func (coverageWebAuthnVerifier) BeginLogin(context.Context, string, string, []WebAuthnCredential) (json.RawMessage, error) {
	return nil, nil
}
func (coverageWebAuthnVerifier) VerifyLogin(context.Context, string, string, []WebAuthnCredential, json.RawMessage) (string, json.RawMessage, error) {
	return "", nil, nil
}

func TestJWTRefreshTokenValidation(t *testing.T) {
	j := NewJWTManager("secret", 15*time.Minute, 24*time.Hour)
	tokens, err := j.GenerateTokenPair("user1", "alice", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := j.ValidateRefreshToken(tokens.AccessToken); err == nil {
		t.Fatal("access token should not validate as refresh")
	}
	claims, err := j.ValidateRefreshToken(tokens.RefreshToken)
	if err != nil || claims.TokenType != "refresh" {
		t.Fatalf("refresh claims = %+v, %v", claims, err)
	}
}

func TestIsAPITokenAndGenerateSecureKey(t *testing.T) {
	if IsAPIToken("eyJhbGciOiJIUzI1NiJ9.token") {
		t.Fatal("JWT should not look like an API token")
	}
	if !IsAPIToken("lsat_abcdefghijklmnopqrstuvwxyz") {
		t.Fatal("lsat_ prefix should be detected")
	}
	key, err := GenerateSecureKey(32)
	if err != nil || key == "" {
		t.Fatalf("GenerateSecureKey = %q, %v", key, err)
	}
}

func TestServiceTokenHelpersAndValidation(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	svc := NewService(db, "testsecret", slog.Default())

	if err := svc.ValidatePassword("short"); err == nil {
		t.Fatal("short password should fail")
	}
	if err := svc.ValidatePassword("alllettersonly"); err == nil {
		t.Fatal("letters-only password should fail")
	}
	if err := svc.ValidatePassword("ValidPassword1"); err != nil {
		t.Fatalf("valid password rejected: %v", err)
	}
	if err := svc.DBHealth(); err != nil {
		t.Fatalf("DBHealth: %v", err)
	}

	user, err := svc.Register(ctx, &RegisterRequest{
		Username: "token-user",
		Password: "ValidPassword1",
		Email:    "token@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	login, err := svc.Login(ctx, &LoginRequest{Username: "token-user", Password: "ValidPassword1"})
	if err != nil {
		t.Fatal(err)
	}
	expiry, err := svc.TokenExpiry(login.Tokens.AccessToken)
	if err != nil || expiry.Before(time.Now()) {
		t.Fatalf("TokenExpiry = %v, %v", expiry, err)
	}
	claims, err := svc.ValidateAccessToken(login.Tokens.AccessToken)
	if err != nil || claims.UserID != user.ID {
		t.Fatalf("ValidateAccessToken = %+v, %v", claims, err)
	}
	if _, err := svc.ValidateRefreshToken(login.Tokens.AccessToken); err == nil {
		t.Fatal("access token should not validate as refresh via service")
	}
}

func TestServiceRefreshRotationAndRevocation(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	svc := NewService(db, "testsecret", slog.Default())
	_, err := svc.Register(ctx, &RegisterRequest{
		Username: "rotate-user",
		Password: "ValidPassword1",
		Email:    "rotate@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	login, err := svc.Login(ctx, &LoginRequest{Username: "rotate-user", Password: "ValidPassword1"})
	if err != nil {
		t.Fatal(err)
	}

	rotated, err := svc.RefreshTokensWithRotation(login.Tokens.RefreshToken, login.User.ID)
	if err != nil || rotated.AccessToken == "" {
		t.Fatalf("RefreshTokensWithRotation: %+v, %v", rotated, err)
	}
	if _, err := svc.RefreshTokensWithRotation(login.Tokens.RefreshToken, login.User.ID); err != ErrTokenRevoked {
		t.Fatalf("reuse should be revoked, got %v", err)
	}

	claims, _ := svc.jwtManager.ValidateAccessToken(rotated.AccessToken)
	jti := GetTokenJTI(claims)
	if err := svc.RevokeToken(jti, claims.UserID, "access", claims.UserID, "test"); err != nil {
		t.Fatalf("RevokeToken: %v", err)
	}
	revoked, err := svc.IsTokenRevoked(jti, "access")
	if err != nil || !revoked {
		t.Fatalf("IsTokenRevoked = %v, %v", revoked, err)
	}
	if _, err := svc.ValidateAccessToken(rotated.AccessToken); err != ErrTokenRevoked {
		t.Fatalf("revoked access token accepted: %v", err)
	}

	if n, err := svc.CleanupExpiredRevocations(); err != nil || n < 0 {
		t.Fatalf("CleanupExpiredRevocations = %d, %v", n, err)
	}
}

func TestServiceUserManagementHelpers(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	svc := NewService(db, "testsecret", slog.Default())

	admin, err := svc.CompleteSetup(ctx, &SetupRequest{
		AdminUsername: "admin",
		AdminPassword: "AdminPassword1",
		AdminEmail:    "admin@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	member, err := svc.Register(ctx, &RegisterRequest{
		Username: "member",
		Password: "MemberPassword1",
		Email:    "member@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}

	users, err := svc.ListUsers(ctx)
	if err != nil || len(users) < 2 {
		t.Fatalf("ListUsers = %#v, %v", users, err)
	}
	page, total, err := svc.ListUsersPaginated(ctx, 0, 10)
	if err != nil || total < 2 || len(page) == 0 {
		t.Fatalf("ListUsersPaginated = %#v total=%d, %v", page, total, err)
	}
	count, err := svc.UserCount(ctx)
	if err != nil || count < 2 {
		t.Fatalf("UserCount = %d, %v", count, err)
	}

	if err := svc.SetPassword(ctx, member.ID, "UpdatedPassword1"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	if err := svc.DeleteUser(ctx, admin.ID); err != ErrLastAdmin {
		t.Fatalf("DeleteUser last admin = %v", err)
	}
	if err := svc.DeleteUser(ctx, member.ID); err != nil {
		t.Fatalf("DeleteUser member: %v", err)
	}
}

func TestPasswordResetServicePaths(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	svc := NewService(db, "testsecret", slog.Default())
	user, err := svc.Register(ctx, &RegisterRequest{
		Username: "reset-user",
		Password: "ResetPassword1",
		Email:    "reset@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}

	previous := config.Get()
	config.SetTestConfig(&config.Config{Network: config.NetworkConfig{
		Caddy: config.CaddyConfig{DefaultDomain: "libreserv.test"},
	}})
	t.Cleanup(func() { config.SetTestConfig(previous) })

	resetSvc := NewPasswordResetService(svc, func() (*email.Sender, error) {
		return nil, errors.New("email unavailable")
	}, db)

	if err := resetSvc.RequestReset(ctx, "missing@example.test"); err != nil {
		t.Fatalf("unknown email reset: %v", err)
	}
	if err := resetSvc.RequestReset(ctx, user.Email); err == nil {
		t.Fatal("expected mailer error")
	}

	token, tokenHash, err := generateResetToken()
	if err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Now().Add(time.Hour)
	if _, err := db.Exec(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
		user.ID, tokenHash, expiresAt); err != nil {
		t.Fatal(err)
	}
	if _, err := resetSvc.ValidateToken(ctx, ""); err == nil {
		t.Fatal("empty token should fail")
	}
	validated, err := resetSvc.ValidateToken(ctx, token)
	if err != nil || validated.ID != user.ID {
		t.Fatalf("ValidateToken = %+v, %v", validated, err)
	}
	if err := resetSvc.ResetPassword(ctx, token, "BrandNewPassword1"); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if _, err := resetSvc.ValidateToken(ctx, token); err == nil {
		t.Fatal("used token should not validate")
	}
}

func TestMFAServiceAvailabilityHelpers(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db, "testsecret", slog.Default())

	if svc.MFATOTPEncryptionKeySet() {
		t.Fatal("TOTP key should start unset")
	}
	svc.SetMFATOTPEncryptionKey("0123456789abcdef")
	if !svc.MFATOTPEncryptionKeySet() {
		t.Fatal("TOTP key should be set")
	}
	if svc.WebAuthnAvailable() {
		t.Fatal("WebAuthn should start unavailable")
	}
	svc.SetWebAuthnVerifier(coverageWebAuthnVerifier{})
	if !svc.WebAuthnAvailable() {
		t.Fatal("WebAuthn verifier should be available")
	}
	if (&MFARequiredError{MFAToken: "token", Email: "a@b.test"}).Error() != "mfa required" {
		t.Fatal("MFARequiredError message mismatch")
	}
}
