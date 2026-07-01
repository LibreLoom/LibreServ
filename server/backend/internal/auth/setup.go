package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
)

var (
	// ErrSetupAlreadyComplete indicates setup is already done.
	ErrSetupAlreadyComplete = errors.New("setup has already been completed")
)

// SetupRequest represents the initial setup request from the WebUI
type SetupRequest struct {
	AdminUsername string                `json:"admin_username"`
	AdminPassword string                `json:"admin_password"`
	AdminEmail    string                `json:"admin_email"`
	SMTP          *config.SMTPConfig    `json:"smtp,omitempty"`
	Notify        *config.Notifications `json:"notify,omitempty"`
}

// SetupStatus represents the current setup status
type SetupStatus struct {
	SetupComplete bool   `json:"setup_complete"`
	Message       string `json:"message"`
}

// GetSetupStatus checks if the initial setup has been completed
// GetSetupStatus reports whether initial setup is finished. It's the
// user-facing completion signal for /setup/status and reconcileSetupState.
//
// Setup is only complete once an admin exists AND that admin has an enabled
// MFA method — NOT merely once a user exists. The admin account is created at
// the ACCOUNT step, but REMOTE_ACCESS, SMTP, and the MFA enrollment step run
// afterward; reporting complete earlier would make reconcileSetupState wipe
// wizard progress and strand the user on the general MfaBlocker.
//
// Intentionally distinct from IsSetupComplete (UserCount>0), which gates the
// RequireSetupComplete middleware protecting /auth/mfa/* enrollment. That one
// must stay permissive so a no-MFA admin can still enroll mid-wizard; do not
// unify the two.
func (s *Service) GetSetupStatus(ctx context.Context) (*SetupStatus, error) {
	count, err := s.UserCount(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to check setup status: %w", err)
	}
	if count == 0 {
		return &SetupStatus{
			SetupComplete: false,
			Message:       "Welcome to LibreServ! Please create your admin account to get started.",
		}, nil
	}

	// A user exists. Setup is only "complete" if an admin has finished MFA
	// enrollment (the wizard's final security step). Without this, the
	// setup-complete repair in reconcileSetupState would fire mid-wizard.
	var adminID string
	err = s.db.QueryRowContext(ctx, `SELECT id FROM users WHERE role = 'admin' LIMIT 1`).Scan(&adminID)
	if err != nil {
		// No admin row (e.g. only non-admin users exist) → setup can't be
		// finished; treat as not complete. A real DB error is surfaced as a 500.
		if errors.Is(err, sql.ErrNoRows) {
			return &SetupStatus{
				SetupComplete: false,
				Message:       "Welcome to LibreServ! Please create your admin account to get started.",
			}, nil
		}
		return nil, fmt.Errorf("failed to look up admin user: %w", err)
	}
	hasMFA, err := s.HasMFA(ctx, adminID)
	if err != nil {
		return nil, fmt.Errorf("failed to check admin MFA status: %w", err)
	}
	if !hasMFA {
		return &SetupStatus{
			SetupComplete: false,
			Message:       "Finish setting up two-factor authentication to complete setup.",
		}, nil
	}

	return &SetupStatus{
		SetupComplete: true,
		Message:       "LibreServ is configured and ready to use",
	}, nil
}

// CompleteSetup creates the initial admin user through the WebUI setup wizard
func (s *Service) CompleteSetup(ctx context.Context, req *SetupRequest) (*models.User, error) {
	logger := slog.Default().With("component", "setup")

	// Check if setup is already complete
	count, err := s.UserCount(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to check user count: %w", err)
	}

	if count > 0 {
		return nil, ErrSetupAlreadyComplete
	}

	// Validate request
	if req.AdminUsername == "" {
		return nil, errors.New("admin username is required")
	}
	if req.AdminPassword == "" {
		return nil, errors.New("admin password is required")
	}

	// Hash password
	hash, err := HashPassword(req.AdminPassword)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	// Create admin user
	admin := &models.User{
		ID:           uuid.New().String(),
		Username:     req.AdminUsername,
		PasswordHash: hash,
		Email:        req.AdminEmail,
		Role:         "admin",
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}

	if err := s.CreateUser(ctx, admin); err != nil {
		return nil, fmt.Errorf("failed to create admin user: %w", err)
	}

	logger.Info("Initial setup complete - admin user created",
		"admin_id", admin.ID,
		"admin_username", admin.Username)

	return admin, nil
}

// IsSetupComplete checks if the initial setup has been completed
func (s *Service) IsSetupComplete(ctx context.Context) (bool, error) {
	count, err := s.UserCount(ctx)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}
