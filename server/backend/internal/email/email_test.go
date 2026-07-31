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
	// RFC 5322: the header block must be separated from the body by a blank
	// line (CRLF CRLF). Regress the bug where the body was appended without
	// the blank line, making the raw MIME headers render as the email body.
	if !strings.Contains(msg, "Content-Type: text/plain; charset=\"utf-8\"\r\n\r\nBody") {
		t.Fatalf("expected blank line between headers and body: %q", msg)
	}
}

func TestRenderHTMLEmailDoesNotEscapeHTML(t *testing.T) {
	data := map[string]interface{}{
		"Username": "alice",
	}
	html, err := RenderHTMLEmail("Test Subject", "Hello\n\nClick below:\nhttps://example.com/reset", data)
	if err != nil {
		t.Fatalf("RenderHTMLEmail returned error: %v", err)
	}
	if strings.Contains(html, "&lt;") || strings.Contains(html, "&gt;") {
		t.Fatalf("HTML content was escaped — html/template auto-escaping is not suppressed:\n%s", html)
	}
	if !strings.Contains(html, `<a href="https://example.com/reset"`) {
		t.Fatalf("expected button link in rendered HTML, got:\n%s", html)
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

func TestRenderMarkdownToHTML(t *testing.T) {
	md := "## What's New\n\n" +
		"- **Faster performance** across the board\n" +
		"- Fixed a bug in the _update checker_\n" +
		"- New `markdown` email rendering\n\n" +
		"[Download v2.0](https://example.com/download)"

	html := RenderMarkdownToHTML(md)

	if !strings.Contains(html, `<h2 style=`) {
		t.Fatalf("expected styled h2 heading, got:\n%s", html)
	}
	if !strings.Contains(html, `font-weight:700`) {
		t.Fatalf("expected bold text for **strong**, got:\n%s", html)
	}
	if !strings.Contains(html, `font-style:italic`) {
		t.Fatalf("expected italic text for _emphasis_, got:\n%s", html)
	}
	if !strings.Contains(html, `<code style=`) {
		t.Fatalf("expected styled inline code, got:\n%s", html)
	}
	if !strings.Contains(html, `<li style=`) {
		t.Fatalf("expected styled list items, got:\n%s", html)
	}
	if !strings.Contains(html, `<a href="https://example.com/download"`) {
		t.Fatalf("expected styled link, got:\n%s", html)
	}
}

func TestRenderHTMLEmailWithMarkdown(t *testing.T) {
	mdBody := "## Release Notes\n\n" +
		"- **New feature**: Markdown emails\n" +
		"- Fixed _formatting_ issues\n\n" +
		"---\n\n" +
		"[Download](https://example.com)"

	data := map[string]interface{}{"markdown": true}
	html, err := RenderHTMLEmail("Update Available", mdBody, data)
	if err != nil {
		t.Fatalf("RenderHTMLEmail with markdown returned error: %v", err)
	}
	if strings.Contains(html, "&lt;") || strings.Contains(html, "&gt;") {
		t.Fatalf("HTML content was escaped in markdown email:\n%s", html)
	}
	if !strings.Contains(html, `<h2 style=`) {
		t.Fatalf("expected styled h2 in markdown email, got:\n%s", html)
	}
	if !strings.Contains(html, `font-weight:700`) {
		t.Fatalf("expected bold in markdown email, got:\n%s", html)
	}
}

func TestRenderHTMLEmailWithoutMarkdown(t *testing.T) {
	plainBody := "Hello\n\nThis is plain text.\n\nhttps://example.com/reset"
	data := map[string]interface{}{}
	html, err := RenderHTMLEmail("Test", plainBody, data)
	if err != nil {
		t.Fatalf("RenderHTMLEmail returned error: %v", err)
	}
	if strings.Contains(html, `<h2`) {
		t.Fatalf("plain text email should not contain markdown headings, got:\n%s", html)
	}
	if !strings.Contains(html, `<p style=`) {
		t.Fatalf("expected styled paragraphs in plain text email, got:\n%s", html)
	}
}
