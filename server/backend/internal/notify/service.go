package notify

import (
	"context"
	"fmt"
	"log/slog"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
)

// Service handles sending notifications to users
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

// AdminNotify sends a notification to all administrators
func (s *Service) AdminNotify(ctx context.Context, subject, body string) error {
	if s.email == nil {
		s.logger.Debug("Email sender not configured, skipping admin notification")
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

	if err := s.email.Send(admins, subject, body); err != nil {
		return fmt.Errorf("failed to send notification email: %w", err)
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
