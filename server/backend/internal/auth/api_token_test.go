package auth

import (
	"context"
	"log/slog"
	"strings"
	"testing"
)

// TestAPITokenLifecycle covers create -> validate -> list -> revoke, plus
// ownership isolation and revocation enforcement.
func TestAPITokenLifecycle(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	svc := NewService(db, "testsecret", slog.Default())

	owner, err := svc.Register(ctx, &RegisterRequest{
		Username: "alice", Password: "SuperSecret123", Email: "alice@example.com",
	})
	if err != nil {
		t.Fatalf("register owner: %v", err)
	}
	other, err := svc.Register(ctx, &RegisterRequest{
		Username: "bob", Password: "SuperSecret123", Email: "bob@example.com",
	})
	if err != nil {
		t.Fatalf("register other: %v", err)
	}

	// Create
	plaintext, rec, err := svc.CreateAPIToken(ctx, owner.ID, "ci-deploy")
	if err != nil {
		t.Fatalf("create api token: %v", err)
	}
	if !strings.HasPrefix(plaintext, "lsat_") {
		t.Fatalf("token missing lsat_ prefix: %q", plaintext)
	}
	if rec.TokenHash != "" {
		t.Fatalf("created record must not expose the hash")
	}
	if rec.UserID != owner.ID {
		t.Fatalf("token user_id mismatch")
	}

	// Validate returns the owning user.
	got, err := svc.ValidateAPIToken(ctx, plaintext)
	if err != nil {
		t.Fatalf("validate api token: %v", err)
	}
	if got.ID != owner.ID {
		t.Fatalf("validate returned wrong user: %s", got.ID)
	}

	// Unknown token is not found.
	if _, err := svc.ValidateAPIToken(ctx, "lsat_unknowngarbage"); err != ErrAPITokenNotFound {
		t.Fatalf("expected ErrAPITokenNotFound, got %v", err)
	}

	// List shows the token (no hash).
	tokens, err := svc.ListAPITokens(ctx, owner.ID)
	if err != nil {
		t.Fatalf("list api tokens: %v", err)
	}
	if len(tokens) != 1 || tokens[0].ID != rec.ID {
		t.Fatalf("list mismatch: %+v", tokens)
	}
	if tokens[0].TokenHash != "" {
		t.Fatalf("list must not expose the hash")
	}

	// Ownership: another user cannot revoke alice's token.
	if err := svc.RevokeAPIToken(ctx, other.ID, rec.ID); err != ErrAPITokenNotFound {
		t.Fatalf("cross-user revoke should be ErrAPITokenNotFound, got %v", err)
	}
	// Revoke (owner) — then the token validates-as-revoked (rejected).
	if err := svc.RevokeAPIToken(ctx, owner.ID, rec.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := svc.ValidateAPIToken(ctx, plaintext); err != ErrAPITokenRevoked {
		t.Fatalf("expected ErrAPITokenRevoked after revoke, got %v", err)
	}
	// Double-revoke is not found (already revoked).
	if err := svc.RevokeAPIToken(ctx, owner.ID, rec.ID); err != ErrAPITokenNotFound {
		t.Fatalf("double revoke should be ErrAPITokenNotFound, got %v", err)
	}
}
