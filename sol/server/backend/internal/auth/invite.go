package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
)

var (
	// ErrInviteNotFound indicates the invite token is unknown, expired, or
	// already redeemed.
	ErrInviteNotFound = errors.New("invite not found or expired")
)

// inviteExpiry is how long an invite token remains redeemable.
const inviteExpiry = 7 * 24 * time.Hour

// hashInviteToken returns the SHA-256 hex digest of an invite bearer token.
func hashInviteToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// CreateInvite creates an invite for email/role + returns the plaintext bearer
// token (emailed once to the invitee) + the stored record. role ∈ {user, admin}.
func (s *Service) CreateInvite(ctx context.Context, inviterID, email, role string) (string, *models.InviteToken, error) {
	if role != "user" && role != "admin" {
		return "", nil, errors.New("role must be user or admin")
	}
	// Reuse the password-reset token generator (32 random bytes → hex + SHA-256).
	plaintext, hash, err := generateResetToken()
	if err != nil {
		return "", nil, err
	}
	now := time.Now()
	inv := &models.InviteToken{
		ID:        uuid.NewString(),
		Email:     email,
		Role:      role,
		InviterID: inviterID,
		TokenHash: hash,
		ExpiresAt: now.Add(inviteExpiry),
		CreatedAt: now,
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO invite_tokens (id, email, role, inviter_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		inv.ID, inv.Email, inv.Role, inv.InviterID, inv.TokenHash, inv.ExpiresAt, inv.CreatedAt); err != nil {
		return "", nil, fmt.Errorf("failed to create invite: %w", err)
	}
	return plaintext, inv, nil
}

// GetInvite looks up an invite by bearer token + returns its public shape.
// valid is false if the token is unknown, expired, or already redeemed; the
// email/role are still returned so the frontend can pre-fill the form when valid.
func (s *Service) GetInvite(ctx context.Context, token string) (email, role string, valid bool, err error) {
	var (
		expiresAt  time.Time
		redeemedAt *time.Time
	)
	err = s.db.QueryRowContext(ctx, `SELECT email, role, expires_at, redeemed_at FROM invite_tokens WHERE token_hash = ?`, hashInviteToken(token)).
		Scan(&email, &role, &expiresAt, &redeemedAt)
	if err != nil {
		return "", "", false, nil // unknown token — don't leak existence
	}
	if time.Now().After(expiresAt) || redeemedAt != nil {
		return email, role, false, nil
	}
	return email, role, true, nil
}

// RedeemInvite validates the invite, creates the user with the inviter's role,
// marks the invite redeemed (single-use), and issues a session. MFA enrollment
// is deferred to the post-redeem mfa_enabled blocker: an admin created without
// MFA is blocked from UI usage (not sign-in) + forced to enroll via /auth/mfa/*.
func (s *Service) RedeemInvite(ctx context.Context, token, username, password string) (*models.User, *TokenPair, error) {
	var (
		id        string
		email     string
		role      string
		expiresAt time.Time
	)
	err := s.db.QueryRowContext(ctx, `SELECT id, email, role, expires_at FROM invite_tokens WHERE token_hash = ? AND redeemed_at IS NULL`, hashInviteToken(token)).
		Scan(&id, &email, &role, &expiresAt)
	if err != nil {
		return nil, nil, ErrInviteNotFound
	}
	if time.Now().After(expiresAt) {
		return nil, nil, ErrInviteNotFound
	}

	// Create the user (Register defaults role=user; promote if the invite is admin).
	user, err := s.Register(ctx, &RegisterRequest{Username: username, Password: password, Email: email})
	if err != nil {
		return nil, nil, err
	}
	if role == "admin" {
		user.Role = "admin"
		if err := s.UpdateUser(ctx, user); err != nil {
			return nil, nil, fmt.Errorf("failed to set admin role: %w", err)
		}
		// Flag MFA as required; the mfa_enabled blocker enforces enrollment on
		// first UI use (the user is NOT blocked from sign-in).
		_ = s.SetMFARequired(ctx, user.ID, true)
	}

	// Mark redeemed (single-use). The WHERE redeemed_at IS NULL guards a race.
	res, err := s.db.ExecContext(ctx, `UPDATE invite_tokens SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL`, time.Now(), id)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to mark invite redeemed: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Lost a redeem race (someone else just redeemed it). Undo the user creation
		// so we don't orphan an account tied to a now-invalid invite.
		_ = s.DeleteUser(ctx, user.ID)
		return nil, nil, ErrInviteNotFound
	}

	tokens, err := s.GenerateTokenPairForUser(ctx, user.ID)
	if err != nil {
		return nil, nil, err
	}
	return user, tokens, nil
}
