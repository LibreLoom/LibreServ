package email

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/smtp"
	"strings"
	"text/template"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

// Sender provides a minimal SMTP sender.
type Sender struct {
	host       string
	auth       smtp.Auth
	from       string
	useTLS     bool
	skipVerify bool
}

// NewSender builds a sender from global config; returns nil if SMTP is not configured.
func NewSender() (*Sender, error) {
	cfgRoot := config.Get()
	if cfgRoot == nil {
		return nil, fmt.Errorf("config not loaded")
	}
	return NewSenderWithConfig(cfgRoot.SMTP)
}

// NewSenderWithConfig builds a sender from a provided SMTP config.
func NewSenderWithConfig(cfg config.SMTPConfig) (*Sender, error) {
	if cfg.Host == "" || cfg.From == "" {
		return nil, fmt.Errorf("smtp not configured")
	}
	auth := smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
	return &Sender{
		host:       fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		auth:       auth,
		from:       cfg.From,
		useTLS:     cfg.UseTLS,
		skipVerify: cfg.SkipVerify,
	}, nil
}

// HealthCheck verifies connectivity and authentication (if configured).
func HealthCheck() error {
	cfg := config.Get().SMTP
	if cfg.Host == "" {
		return fmt.Errorf("smtp not configured")
	}
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	skipVerify := resolveSkipVerify(cfg.SkipVerify)
	if cfg.Port == 465 || cfg.Port == 2465 {
		return checkImplicitTLS(addr, cfg, skipVerify)
	}
	if cfg.UseTLS {
		return checkSTARTTLS(addr, cfg, skipVerify)
	}
	c, err := smtp.Dial(addr)
	if err != nil {
		return err
	}
	defer c.Close()
	if cfg.Username != "" {
		auth := smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
		if err := c.Auth(auth); err != nil {
			return err
		}
	}
	return nil
}

// TestSMTP validates the provided SMTP config without saving it.
func TestSMTP(cfg config.SMTPConfig) error {
	if cfg.Host == "" {
		return fmt.Errorf("smtp host required")
	}
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	skipVerify := resolveSkipVerify(cfg.SkipVerify)
	if cfg.Port == 465 || cfg.Port == 2465 {
		return checkImplicitTLS(addr, cfg, skipVerify)
	}
	if cfg.UseTLS {
		return checkSTARTTLS(addr, cfg, skipVerify)
	}
	c, err := smtp.Dial(addr)
	if err != nil {
		return err
	}
	defer c.Close()
	if cfg.Username != "" {
		auth := smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
		if err := c.Auth(auth); err != nil {
			return err
		}
	}
	return nil
}

func resolveSkipVerify(skipVerify bool) bool {
	if skipVerify {
		if c := config.Get(); c != nil && c.Server.Mode == "production" {
			log.Printf("warning: InsecureSkipVerify overridden to false in production mode")
			return false
		}
	}
	return skipVerify
}

func checkSTARTTLS(addr string, cfg config.SMTPConfig, skipVerify bool) error {
	c, err := smtp.Dial(addr)
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.StartTLS(&tls.Config{InsecureSkipVerify: skipVerify}); err != nil {
		return err
	}
	if cfg.Username != "" {
		auth := smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
		if err := c.Auth(auth); err != nil {
			return err
		}
	}
	return nil
}

func checkImplicitTLS(addr string, cfg config.SMTPConfig, skipVerify bool) error {
	conn, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: skipVerify})
	if err != nil {
		return err
	}
	defer conn.Close()
	host := strings.Split(addr, ":")[0]
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer client.Close()
	if cfg.Username != "" {
		auth := smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
		if err := client.Auth(auth); err != nil {
			return err
		}
	}
	return nil
}

// Send sends a plaintext email.
func (s *Sender) Send(to []string, subject, body string) error {
	if len(to) == 0 {
		return fmt.Errorf("missing recipients")
	}
	msg := buildMessage(s.from, to, subject, body)
	port := s.port()
	if port == 465 || port == 2465 {
		return s.sendImplicitTLS(to, msg)
	}
	if s.useTLS {
		return s.sendSTARTTLS(to, msg)
	}
	return smtp.SendMail(s.host, s.auth, s.from, to, []byte(msg))
}

func (s *Sender) port() int {
	parts := strings.Split(s.host, ":")
	if len(parts) != 2 {
		return 0
	}
	var port int
	fmt.Sscanf(parts[1], "%d", &port)
	return port
}

func (s *Sender) sendSTARTTLS(to []string, msg string) error {
	c, err := smtp.Dial(s.host)
	if err != nil {
		return err
	}
	defer c.Close()
	skipVerify := resolveSkipVerify(s.skipVerify)
	if err := c.StartTLS(&tls.Config{InsecureSkipVerify: skipVerify}); err != nil {
		return err
	}
	if err := c.Auth(s.auth); err != nil {
		return err
	}
	if err := c.Mail(s.from); err != nil {
		return err
	}
	for _, r := range to {
		if err := c.Rcpt(r); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		return err
	}
	return w.Close()
}

func (s *Sender) sendImplicitTLS(to []string, msg string) error {
	skipVerify := resolveSkipVerify(s.skipVerify)
	conn, err := tls.Dial("tcp", s.host, &tls.Config{InsecureSkipVerify: skipVerify})
	if err != nil {
		return err
	}
	client, err := smtp.NewClient(conn, strings.Split(s.host, ":")[0])
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.Auth(s.auth); err != nil {
		return err
	}
	if err := client.Mail(s.from); err != nil {
		return err
	}
	for _, r := range to {
		if err := client.Rcpt(r); err != nil {
			return err
		}
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		return err
	}
	return w.Close()
}

// sanitizeHeader removes CR and LF characters to prevent email header injection
func sanitizeHeader(value string) string {
	// Remove both \r and \n to prevent header injection attacks
	value = strings.ReplaceAll(value, "\r", "")
	value = strings.ReplaceAll(value, "\n", "")
	return value
}

func buildMessage(from string, to []string, subject, body string) string {
	// Sanitize all header values to prevent injection attacks
	from = sanitizeHeader(from)
	subject = sanitizeHeader(subject)

	// Sanitize recipient addresses
	sanitizedTo := make([]string, len(to))
	for i, addr := range to {
		sanitizedTo[i] = sanitizeHeader(addr)
	}

	headers := []string{
		"From: " + from,
		"To: " + strings.Join(sanitizedTo, ","),
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=\"utf-8\"",
		"",
	}
	return strings.Join(headers, "\r\n") + body
}

// RenderTemplate renders a text template with the provided data.
func RenderTemplate(tmpl string, data any) (string, error) {
	if tmpl == "" {
		return "", fmt.Errorf("template empty")
	}
	t, err := template.New("email").Parse(tmpl)
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	if err := t.Execute(&sb, data); err != nil {
		return "", err
	}
	return sb.String(), nil
}
