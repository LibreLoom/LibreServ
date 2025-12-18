package email

import (
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func TestNewSenderWithConfigValidation(t *testing.T) {
	if _, err := NewSenderWithConfig(config.SMTPConfig{}); err == nil {
		t.Fatalf("expected error when host/from are missing")
	}
}

func TestNewSenderWithConfig(t *testing.T) {
	cfg := config.SMTPConfig{
		Host:       "smtp.example.com",
		Port:       587,
		Username:   "user",
		Password:   "pass",
		From:       "noreply@example.com",
		UseTLS:     true,
		SkipVerify: true,
	}
	sender, err := NewSenderWithConfig(cfg)
	if err != nil {
		t.Fatalf("NewSenderWithConfig returned error: %v", err)
	}
	if sender.host != "smtp.example.com:587" {
		t.Fatalf("expected host to include port, got %q", sender.host)
	}
	if !sender.useTLS || !sender.skipVerify {
		t.Fatalf("expected TLS flags to be carried through")
	}
}

func TestSendMissingRecipients(t *testing.T) {
	s := &Sender{}
	if err := s.Send(nil, "hello", "body"); err == nil {
		t.Fatalf("expected error when no recipients are provided")
	}
}

func TestBuildMessage(t *testing.T) {
	msg := buildMessage("from@example.com", []string{"a@example.com", "b@example.com"}, "Hello", "Body")
	if !strings.Contains(msg, "Subject: Hello") {
		t.Fatalf("expected subject header in message: %q", msg)
	}
	if !strings.Contains(msg, "To: a@example.com,b@example.com") {
		t.Fatalf("expected recipients list in message: %q", msg)
	}
	if !strings.HasSuffix(msg, "Body") {
		t.Fatalf("expected body at end of message: %q", msg)
	}
}

func TestRenderTemplate(t *testing.T) {
	out, err := RenderTemplate("Hello {{.Name}}", map[string]string{"Name": "World"})
	if err != nil {
		t.Fatalf("RenderTemplate returned error: %v", err)
	}
	if out != "Hello World" {
		t.Fatalf("unexpected template output: %q", out)
	}
	if _, err := RenderTemplate("", nil); err == nil {
		t.Fatalf("expected error for empty template")
	}
}
