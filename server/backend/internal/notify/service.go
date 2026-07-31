package notify

import (
	"context"
	"fmt"
	"log/slog"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
)

// Service handles sending notifications to users
// Note: For security-specific notifications with formatted alerts, use security.EmailNotifier
type Service struct {
	auth   *auth.Service
	email  *email.Sender
	logger *slog.Logger
}

// NewService creates a new notification service
func NewService(authSvc *auth.Service, emailSender *email.Sender) *Service {
	return &Service{
		auth:   authSvc,
		email:  emailSender,
		logger: slog.Default().With("component", "notify"),
	}
}

// SetSender swaps the email sender at runtime (SMTP settings changed, e.g.
// after Connect provisioning). nil disables email notifications.
func (s *Service) SetSender(emailSender *email.Sender) { s.email = emailSender }

// NotifySpecific sends a notification to specific recipients (not just admins)
// This is useful for targeted notifications without admin lookup overhead
func (s *Service) NotifySpecific(recipients []string, subject, body string) error {
	if s.email == nil {
		s.logger.Debug("Email sender not configured, skipping notification")
		return nil
	}

	if len(recipients) == 0 {
		s.logger.Warn("No recipients provided for notification")
		return nil
	}

	htmlBody, htmlErr := email.RenderHTMLEmail(subject, body, map[string]interface{}{})
	if htmlErr != nil {
		s.logger.Warn("Failed to render HTML email, falling back to plaintext", "error", htmlErr)
		return s.email.Send(recipients, subject, body)
	}

	if err := s.email.SendHTMLEmail(recipients, subject, htmlBody); err != nil {
		s.logger.Warn("Failed to send HTML email, falling back to plaintext", "error", err)
		return s.email.Send(recipients, subject, body)
	}

	s.logger.Info("Notification sent", "recipients", len(recipients), "subject", subject)
	return nil
}

// AdminNotify sends a notification to all administrators
func (s *Service) AdminNotify(ctx context.Context, subject, body string) error {
	return s.AdminNotifyWithData(ctx, subject, body, nil)
}

// AdminNotifyWithData sends a notification to all administrators with optional template data
func (s *Service) AdminNotifyWithData(ctx context.Context, subject, body string, data map[string]interface{}) error {
	if s.email == nil {
		s.logger.Debug("Email sender not configured, skipping admin notification")
		return nil
	}
	if cfg := config.Get(); cfg != nil && !cfg.Notify.Enabled {
		s.logger.Debug("Notifications disabled, skipping admin notification")
		return nil
	}

	admins, err := s.getAdminEmails(ctx)
	if err != nil {
		return fmt.Errorf("failed to get admin emails: %w", err)
	}

	if len(admins) == 0 {
		s.logger.Warn("No admins with email addresses found")
		return nil
	}

	if data == nil {
		data = map[string]interface{}{}
	}

	htmlBody, htmlErr := email.RenderHTMLEmail(subject, body, data)
	if htmlErr != nil {
		s.logger.Warn("Failed to render HTML email, falling back to plaintext", "error", htmlErr)
		return s.email.Send(admins, subject, body)
	}

	if err := s.email.SendHTMLEmail(admins, subject, htmlBody); err != nil {
		s.logger.Warn("Failed to send HTML email, falling back to plaintext", "error", err)
		return s.email.Send(admins, subject, body)
	}

	s.logger.Info("Admin notification sent", "recipients", len(admins), "subject", subject)
	return nil
}

func (s *Service) getAdminEmails(ctx context.Context) ([]string, error) {
	users, err := s.auth.ListUsers(ctx)
	if err != nil {
		return nil, err
	}

	var emails []string
	for _, u := range users {
		if u.Role == "admin" && u.Email != "" {
			emails = append(emails, u.Email)
		}
	}
	return emails, nil
}
