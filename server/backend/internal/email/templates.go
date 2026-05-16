package email

import (
	"bytes"
	"fmt"
	"html/template"
	"net/smtp"
	"strings"
)

// EmailTemplate represents an email template
type EmailTemplate struct {
	Key     string
	Subject string
	Body    string
	HTML    string
}

// DefaultTemplates contains all default email templates
var DefaultTemplates = map[string]EmailTemplate{
	"password_reset": {
		Key:     "password_reset",
		Subject: "Reset Your LibreServ Password",
		Body: `Hello {{.Username}},

A password reset was requested for your LibreServ account.

Click the link below to reset your password:
{{.ResetLink}}

This link expires in 1 hour.

If you didn't request this, you can safely ignore this email.

— LibreServ`,
	},
	"welcome": {
		Key:     "welcome",
		Subject: "Welcome to LibreServ!",
		Body: `Hello {{.Username}},

Welcome to LibreServ! Your account has been created.

You can now log in and start managing your self-hosted applications.

— LibreServ`,
	},
	"health_alert": {
		Key:     "health_alert",
		Subject: "⚠️ LibreServ Health Alert",
		Body: `Hello,

LibreServ has detected a health issue:

{{.HealthCheck}}

Status: {{.Status}}
Time: {{.Timestamp}}

Please check your system as soon as possible.

— LibreServ`,
	},
	"security_alert": {
		Key:     "security_alert",
		Subject: "LibreServ Security Alert",
		Body: `Hello {{.Username}},

A security event occurred on your LibreServ:

Event: {{.EventType}}
Time: {{.Timestamp}}
IP: {{.IPAddress}}

If this wasn't you, please secure your account immediately.

— LibreServ`,
	},
}

// TemplateData holds common template variables
type TemplateData struct {
	Username    string
	Email       string
	ResetLink   string
	Timestamp   string
	IPAddress   string
	EventType   string
	HealthCheck string
	Status      string
	ServerName  string
	FailedCount int
}

// GetTemplate retrieves a template by key
func GetTemplate(key string) (*EmailTemplate, error) {
	if tmpl, ok := DefaultTemplates[key]; ok {
		return &tmpl, nil
	}
	return nil, fmt.Errorf("template not found: %s", key)
}

// RenderTemplateByKey renders a template with data (returns subject and body)
func RenderTemplateByKey(key string, data map[string]interface{}) (string, string, error) {
	tmpl, err := GetTemplate(key)
	if err != nil {
		return "", "", err
	}

	subject := tmpl.Subject
	bodyTmpl, err := template.New("email_body").Parse(tmpl.Body)
	if err != nil {
		return "", "", fmt.Errorf("failed to parse template: %w", err)
	}

	var bodyBuf bytes.Buffer
	if err := bodyTmpl.Execute(&bodyBuf, data); err != nil {
		return "", "", fmt.Errorf("failed to execute template: %w", err)
	}

	return subject, bodyBuf.String(), nil
}

// RenderTemplateWithKey renders a template using database or default
func RenderTemplateWithKey(key string, data map[string]interface{}) (string, string, error) {
	// Try to get from database first (would be implemented in settings service)
	// For now, use defaults
	return RenderTemplateByKey(key, data)
}

// UniversalEmailTemplate is the single HTML template for ALL LibreServ emails
// Follows the Simplex Mono design language: flat, monospace headings, sans-serif body,
// white/black/grey palette, pill buttons, rounded cards, no shadows, no gradients.
const UniversalEmailTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>{{.Subject}}</title>
</head>
<body style="margin:0; padding:32px 16px; background-color:#ffffff; font-family:'Noto Sans','Helvetica Neue',Arial,sans-serif; color:#000000; -webkit-font-smoothing:antialiased;">
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; margin:0 auto;">
		<tr>
			<td style="border:2px solid #000000; border-radius:24px; overflow:hidden;">
				<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
					<tr>
						<td style="padding:40px 32px 8px 32px; font-family:'FreeMono','Courier New',Courier,monospace; font-size:24px; font-weight:400; color:#000000; text-align:center;">
							LibreServ
						</td>
					</tr>
					<tr>
						<td style="padding:8px 32px 0 32px;">
							<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
								<tr>
									<td style="height:2px; background-color:#767676; font-size:1px; line-height:1px;">&nbsp;</td>
								</tr>
							</table>
						</td>
					</tr>
					<tr>
						<td style="padding:32px 32px; font-family:'Noto Sans','Helvetica Neue',Arial,sans-serif; font-size:16px; line-height:1.6; color:#000000;">
							{{.Content}}
						</td>
					</tr>
					<tr>
						<td style="padding:0 32px 8px 32px;">
							<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
								<tr>
									<td style="height:1px; background-color:#767676; font-size:1px; line-height:1px;">&nbsp;</td>
								</tr>
							</table>
						</td>
					</tr>
					<tr>
						<td style="padding:16px 32px 32px 32px; font-family:'FreeMono','Courier New',Courier,monospace; font-size:13px; line-height:1.5; color:#767676; text-align:center;">
							LibreServ<br>
							<span style="font-family:'Noto Sans','Helvetica Neue',Arial,sans-serif; font-size:12px;">Self&#8209;hosted application management</span><br>
							<span style="font-family:'Noto Sans','Helvetica Neue',Arial,sans-serif; font-size:11px; color:#767676;">This email was sent from your LibreServ instance.</span>
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
</body>
</html>`

// RenderHTMLEmail renders ANY email using the universal LibreServ template.
// When data["markdown"] is true, the body is rendered as Markdown; otherwise plain text.
func RenderHTMLEmail(subject, plainTextBody string, data map[string]interface{}) (string, error) {
	tmpl, err := template.New("universal_email").Parse(UniversalEmailTemplate)
	if err != nil {
		return "", fmt.Errorf("failed to parse universal template: %w", err)
	}

	formattedData := make(map[string]interface{})
	for k, v := range data {
		formattedData[k] = v
	}

	bodyStr := plainTextBody
	if bodyStr == "" {
		bodyStr = fmt.Sprintf("%v", data["body"])
	}

	var htmlContent string
	if isMarkdown, _ := data["markdown"].(bool); isMarkdown {
		htmlContent = RenderMarkdownToHTML(bodyStr)
	} else {
		htmlContent = convertTextToHTML(bodyStr)
	}

	formattedData["Content"] = template.HTML(htmlContent)
	formattedData["Subject"] = subject

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, formattedData); err != nil {
		return "", fmt.Errorf("failed to execute universal template: %w", err)
	}

	return buf.String(), nil
}

// convertTextToHTML converts plain text email body to HTML with Simplex Mono styling
func convertTextToHTML(text string) string {
	var html strings.Builder

	paragraphs := strings.Split(text, "\n\n")

	for _, p := range paragraphs {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}

		if containsURL(p) {
			lines := strings.Split(p, "\n")
			for _, line := range lines {
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}
				url := extractURL(line)
				if url != "" {
					label := inferButtonLabel(line, url)
					html.WriteString(fmt.Sprintf(
						`<div style="text-align:center; padding:16px 0;">`+
							`<a href="%s" style="display:inline-block; background-color:#000000; color:#ffffff; padding:14px 32px; border-radius:9999px; text-decoration:none; font-family:'Noto Sans','Helvetica Neue',Arial,sans-serif; font-size:15px; font-weight:700;">%s</a>`+
							`</div>`,
						url, label,
					))
				} else {
					html.WriteString(renderLine(line))
				}
			}
		} else {
			html.WriteString(renderParagraph(p))
		}
	}

	return html.String()
}

// containsURL checks whether a paragraph contains an http(s) link
func containsURL(text string) bool {
	return strings.Contains(text, "http://") || strings.Contains(text, "https://")
}

// renderParagraph wraps a block of text in a <p> with inline styles, converting \n to <br>
func renderParagraph(text string) string {
	escaped := strings.ReplaceAll(text, "\n", "<br>")
	return fmt.Sprintf(`<p style="margin:0 0 16px 0; font-family:'Noto Sans','Helvetica Neue',Arial,sans-serif; font-size:16px; line-height:1.6; color:#000000;">%s</p>`, escaped)
}

// renderLine renders a single non-URL line as a <p>
func renderLine(line string) string {
	return fmt.Sprintf(`<p style="margin:0 0 8px 0; font-family:'Noto Sans','Helvetica Neue',Arial,sans-serif; font-size:16px; line-height:1.6; color:#000000;">%s</p>`, line)
}

// inferButtonLabel chooses a button label based on context clues in the surrounding text
func inferButtonLabel(line string, url string) string {
	lower := strings.ToLower(line + " " + url)
	switch {
	case strings.Contains(lower, "reset") || strings.Contains(lower, "password"):
		return "Reset Password"
	case strings.Contains(lower, "verify") || strings.Contains(lower, "confirm"):
		return "Confirm"
	case strings.Contains(lower, "login") || strings.Contains(lower, "sign"):
		return "Sign In"
	default:
		return "Open"
	}
}

// extractURL extracts the first URL from a string
func extractURL(text string) string {
	// Simple URL extraction
	start := strings.Index(text, "http")
	if start == -1 {
		return ""
	}

	// Find end of URL (space or end of string)
	end := strings.IndexAny(text[start:], " \n\t")
	if end == -1 {
		return text[start:]
	}

	return text[start : start+end]
}

// SendHTMLEmail sends an HTML email
func (s *Sender) SendHTMLEmail(to []string, subject, htmlBody string) error {
	if len(to) == 0 {
		return fmt.Errorf("missing recipients")
	}

	msg := s.buildHTMLMessage(s.from, to, subject, htmlBody)
	port := s.port()
	if port == 465 || port == 2465 {
		return s.sendImplicitTLS(to, msg)
	}
	if s.useTLS {
		return s.sendSTARTTLS(to, msg)
	}
	return smtp.SendMail(s.host, s.makeAuth(), s.from, to, []byte(msg))
}

func (s *Sender) buildHTMLMessage(from string, to []string, subject, htmlBody string) string {
	from = sanitizeHeader(from)
	subject = sanitizeHeader(subject)

	sanitizedTo := make([]string, len(to))
	for i, addr := range to {
		sanitizedTo[i] = sanitizeHeader(addr)
	}

	headers := []string{
		"From: " + from,
		"To: " + strings.Join(sanitizedTo, ","),
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=\"utf-8\"",
		"",
	}

	return strings.Join(headers, "\r\n") + htmlBody
}
