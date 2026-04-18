package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/url"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
)

// PasswordResetService handles password reset functionality
type PasswordResetService struct {
	authService *Service
	mailer      func() (*email.Sender, error)
	db          DatabaseInterface
}

// DatabaseInterface abstracts database operations
type DatabaseInterface interface {
	ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...interface{}) *sql.Row
}

// NewPasswordResetService creates a new password reset service
func NewPasswordResetService(authService *Service, mailer func() (*email.Sender, error), db DatabaseInterface) *PasswordResetService {
	return &PasswordResetService{
		authService: authService,
		mailer:      mailer,
		db:          db,
	}
}

// ResetRequest represents a password reset request
type ResetRequest struct {
	Email string `json:"email"`
}

// ResetConfirm represents a password reset confirmation
type ResetConfirm struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

// generateResetToken generates a secure random token
func generateResetToken() (string, string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", "", fmt.Errorf("failed to generate random bytes: %w", err)
	}
	token := hex.EncodeToString(bytes)
	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])
	return token, tokenHash, nil
}

// RequestReset creates a password reset token and sends email
func (s *PasswordResetService) RequestReset(ctx context.Context, reqEmail string) error {
	user, err := s.authService.GetUserByEmail(ctx, reqEmail)
	if err != nil {
		slog.Info("Password reset requested for unknown email", "email", reqEmail)
		return nil
	}

	var recentCount int64
	row := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM password_reset_tokens 
		WHERE user_id = ? AND created_at > datetime('now', '-1 hour')
	`, user.ID)
	if err := row.Scan(&recentCount); err != nil {
		return fmt.Errorf("rate limit check failed")
	}
	
	if recentCount >= 3 {
		return fmt.Errorf("too many requests, please try again later")
	}

	token, tokenHash, err := generateResetToken()
	if err != nil {
		return err
	}

	expiresAt := time.Now().Add(1 * time.Hour)
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
		VALUES (?, ?, ?)
	`, user.ID, tokenHash, expiresAt)
	if err != nil {
		return fmt.Errorf("failed to store reset token: %w", err)
	}

	cfg := config.Get()
	domain := "localhost:8080"
	if cfg.Network.Caddy.DefaultDomain != "" {
		domain = cfg.Network.Caddy.DefaultDomain
	}
	
	resetURL := &url.URL{
		Scheme:   "https",
		Host:     domain,
		Path:     "/reset-password",
		RawQuery: url.Values{"token": []string{token}}.Encode(),
	}
	if cfg.Server.Mode != "production" {
		resetURL.Scheme = "http"
	}

	mailer, err := s.mailer()
	if err != nil {
		return fmt.Errorf("email service not configured")
	}

	templateData := map[string]interface{}{
		"Username":  user.Username,
		"ResetLink": resetURL.String(),
		"Body": fmt.Sprintf(`Hello %s,

A password reset was requested for your LibreServ account.

Click the link below to reset your password:
%s

This link expires in 1 hour.

— LibreServ`, user.Username, resetURL.String()),
	}

	subject, body, err := email.RenderTemplateByKey("password_reset", templateData)
	if err != nil {
		subject = "Reset Your LibreServ Password"
		body = templateData["Body"].(string)
	}

	htmlBody, err := email.RenderHTMLEmail(subject, body, templateData)
	if err != nil {
		return mailer.Send([]string{user.Email}, subject, body)
	}
	
	return mailer.SendHTMLEmail([]string{user.Email}, subject, htmlBody)
}

// ValidateToken validates a reset token and returns the user
func (s *PasswordResetService) ValidateToken(ctx context.Context, token string) (*models.User, error) {
	if token == "" {
		return nil, fmt.Errorf("token required")
	}

	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])

	var userID string
	row := s.db.QueryRowContext(ctx, `
		SELECT user_id FROM password_reset_tokens 
		WHERE token_hash = ? AND used = FALSE AND expires_at > ?
		LIMIT 1
	`, tokenHash, time.Now())
	
	if err := row.Scan(&userID); err != nil {
		return nil, fmt.Errorf("invalid or expired token")
	}

	return s.authService.GetUserByID(ctx, userID)
}

// ResetPassword resets a user's password using a valid token
func (s *PasswordResetService) ResetPassword(ctx context.Context, token, newPassword string) error {
	user, err := s.ValidateToken(ctx, token)
	if err != nil {
		return err
	}

	err = s.authService.ChangePassword(ctx, user.ID, "", newPassword)
	if err != nil {
		return fmt.Errorf("failed to reset password: %w", err)
	}

	_, err = s.db.ExecContext(ctx, `
		UPDATE password_reset_tokens SET used = TRUE WHERE token_hash = ?
	`, sha256.Sum256([]byte(token)))
	if err != nil {
		slog.Warn("Failed to invalidate reset token", "error", err)
	}

	slog.Info("Password reset successful", "user_id", user.ID)
	return nil
}
