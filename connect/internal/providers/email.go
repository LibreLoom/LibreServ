package providers

import (
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
)

// SendEmail sends a plain-text email using the configured SMTP server.
// The from address comes from config.C.SMTP.From.
func SendEmail(to, subject, body string) error {
	cfg := config.C.SMTP
	if cfg.Host == "" {
		return fmt.Errorf("email sending is not configured. Add an SMTP server in Settings → Service Providers.")
	}

	from := cfg.From
	if from == "" {
		from = "noreply@libreloom.org"
	}

	msg := strings.Join([]string{
		"From: " + from,
		"To: " + to,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		body,
	}, "\r\n")

	var auth smtp.Auth
	if cfg.Username != "" && cfg.Password != "" {
		auth = smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
	}

	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	if err := smtp.SendMail(addr, auth, from, []string{to}, []byte(msg)); err != nil {
		return fmt.Errorf("could not send email: %w", err)
	}
	return nil
}

// SendHTMLEmail sends an HTML email using the configured SMTP server.
func SendHTMLEmail(to, subject, htmlBody string) error {
	cfg := config.C.SMTP
	if cfg.Host == "" {
		return fmt.Errorf("email sending is not configured. Add an SMTP server in Settings → Service Providers.")
	}

	from := cfg.From
	if from == "" {
		from = "noreply@libreloom.org"
	}

	msg := strings.Join([]string{
		"From: " + from,
		"To: " + to,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=UTF-8",
		"",
		htmlBody,
	}, "\r\n")

	var auth smtp.Auth
	if cfg.Username != "" && cfg.Password != "" {
		auth = smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
	}

	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	if err := smtp.SendMail(addr, auth, from, []string{to}, []byte(msg)); err != nil {
		return fmt.Errorf("could not send email: %w", err)
	}
	return nil
}
