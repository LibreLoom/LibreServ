package auth

import (
	"context"
	"errors"
	"log/slog"
	"testing"
)

// TestInviteCreateGetRedeem covers the invite lifecycle: admin creates an
// invite, the invitee looks it up, redeems it (user created with the inviter's
// role + a session), and the invite becomes single-use.
func TestInviteCreateGetRedeem(t *testing.T) {
	ctx := context.Background()
	svc := NewService(newTestDB(t), "testsecret", slog.Default())

	inviter, err := svc.Register(ctx, &RegisterRequest{
		Username: "admin1", Password: "SuperSecret123", Email: "admin1@example.com",
	})
	if err != nil {
		t.Fatalf("register inviter: %v", err)
	}

	// Admin invites someone as an admin.
	plaintext, inv, err := svc.CreateInvite(ctx, inviter.ID, "newbie@example.com", "admin")
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if plaintext == "" || inv.Role != "admin" || inv.Email != "newbie@example.com" {
		t.Fatalf("CreateInvite bad record: %+v", inv)
	}

	// Lookup is valid before redemption.
	email, role, valid, _ := svc.GetInvite(ctx, plaintext)
	if !valid || email != "newbie@example.com" || role != "admin" {
		t.Fatalf("GetInvite: email=%q role=%q valid=%v", email, role, valid)
	}
	// Unknown token is invalid (no leak).
	if _, _, valid, _ := svc.GetInvite(ctx, "deadbeef"); valid {
		t.Fatalf("unknown token should be invalid")
	}

	// Redeem: creates the user with the inviter's role + a session.
	user, tokens, err := svc.RedeemInvite(ctx, plaintext, "newbie", "FreshPassword123")
	if err != nil {
		t.Fatalf("RedeemInvite: %v", err)
	}
	if user.Role != "admin" {
		t.Fatalf("redeemed user role = %q, want admin", user.Role)
	}
	if tokens == nil || tokens.AccessToken == "" {
		t.Fatalf("RedeemInvite: no session tokens")
	}

	// The invite is now single-use: lookup invalid + re-redeem fails.
	if _, _, valid, _ := svc.GetInvite(ctx, plaintext); valid {
		t.Fatalf("invite should be invalid after redeem")
	}
	if _, _, err := svc.RedeemInvite(ctx, plaintext, "other", "FreshPassword123"); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("re-redeem: expected ErrInviteNotFound, got %v", err)
	}
}

// TestInviteRoleUser verifies a user-role invite creates a non-admin (no
// mfa_required flag).
func TestInviteRoleUser(t *testing.T) {
	ctx := context.Background()
	svc := NewService(newTestDB(t), "testsecret", slog.Default())
	inviter, _ := svc.Register(ctx, &RegisterRequest{
		Username: "admin2", Password: "SuperSecret123", Email: "admin2@example.com",
	})
	plaintext, _, err := svc.CreateInvite(ctx, inviter.ID, "reg@example.com", "user")
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	user, _, err := svc.RedeemInvite(ctx, plaintext, "reguser", "FreshPassword123")
	if err != nil {
		t.Fatalf("RedeemInvite: %v", err)
	}
	if user.Role != "user" {
		t.Fatalf("role = %q, want user", user.Role)
	}
}
