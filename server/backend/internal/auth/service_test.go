package auth

import (
	"context"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// helper to create a temp DB and run migrations
func newTestDB(t *testing.T) *database.DB {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("failed to migrate test db: %v", err)
	}
	return db
}

func TestRegisterLoginChangePassword(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	svc := NewService(db, "testsecret")

	// register
	user, err := svc.Register(ctx, &RegisterRequest{
		Username: "alice",
		Password: "SuperSecret123",
		Email:    "alice@example.com",
	})
	if err != nil {
		t.Fatalf("register failed: %v", err)
	}
	if user.Role != "user" {
		t.Fatalf("expected role user, got %s", user.Role)
	}

	// duplicate register
	if _, err := svc.Register(ctx, &RegisterRequest{
		Username: "alice",
		Password: "AnotherSecret456",
	}); err != ErrUserExists {
		t.Fatalf("expected ErrUserExists, got %v", err)
	}

	// login
	resp, err := svc.Login(ctx, &LoginRequest{
		Username: "alice",
		Password: "SuperSecret123",
	})
	if err != nil {
		t.Fatalf("login failed: %v", err)
	}
	if resp.Tokens == nil || resp.Tokens.AccessToken == "" || resp.Tokens.RefreshToken == "" {
		t.Fatalf("expected tokens to be issued")
	}

	// change password
	if err := svc.ChangePassword(ctx, user.ID, "SuperSecret123", "NewSuperSecret789"); err != nil {
		t.Fatalf("change password failed: %v", err)
	}

	// old password should fail
	if _, err := svc.Login(ctx, &LoginRequest{
		Username: "alice",
		Password: "SuperSecret123",
	}); err == nil {
		t.Fatalf("expected old password login to fail")
	}

	// new password should work
	if _, err := svc.Login(ctx, &LoginRequest{
		Username: "alice",
		Password: "NewSuperSecret789",
	}); err != nil {
		t.Fatalf("login with new password failed: %v", err)
	}
}

func TestSetupFlow(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	svc := NewService(db, "testsecret")

	complete, err := svc.IsSetupComplete(ctx)
	if err != nil {
		t.Fatalf("IsSetupComplete failed: %v", err)
	}
	if complete {
		t.Fatalf("expected setup to be incomplete initially")
	}

	admin, err := svc.CompleteSetup(ctx, &SetupRequest{
		AdminUsername: "admin",
		AdminPassword: "AdminPassword123",
		AdminEmail:    "admin@example.com",
	})
	if err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}
	if admin.Role != "admin" {
		t.Fatalf("expected admin role, got %s", admin.Role)
	}

	complete, err = svc.IsSetupComplete(ctx)
	if err != nil {
		t.Fatalf("IsSetupComplete failed: %v", err)
	}
	if !complete {
		t.Fatalf("expected setup to be complete after admin creation")
	}
}
