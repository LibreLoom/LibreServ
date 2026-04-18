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
const UniversalEmailTemplate = `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body { 
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; 
			background: #f5f5f5; 
			margin: 0; 
			padding: 20px; 
		}
		.container { 
			max-width: 600px; 
			margin: 0 auto; 
			background: white; 
			border-radius: 24px; 
			overflow: hidden;
			box-shadow: 0 4px 6px rgba(0,0,0,0.1);
		}
		.header { 
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
			color: white; 
			padding: 32px 24px; 
			text-align: center;
		}
		.header h1 {
			margin: 0;
			font-size: 28px;
			font-weight: 600;
			letter-spacing: -0.5px;
		}
		.logo {
			width: 48px;
			height: 48px;
			margin-bottom: 12px;
		}
		.content { 
			padding: 32px 24px; 
			color: #1a1a1a;
			line-height: 1.6;
		}
		.content p {
			margin: 0 0 16px 0;
		}
		.button { 
			display: inline-block;
			background: #667eea; 
			color: white; 
			padding: 14px 32px; 
			border-radius: 9999px; 
			text-decoration: none; 
			font-weight: 600;
			margin: 20px 0;
		}
		.button:hover {
			background: #5568d3;
		}
		.alert-box {
			background: #fef3c7;
			border-left: 4px solid #f59e0b;
			padding: 16px;
			border-radius: 8px;
			margin: 20px 0;
		}
		.success-box {
			background: #d1fae5;
			border-left: 4px solid #10b981;
			padding: 16px;
			border-radius: 8px;
			margin: 20px 0;
		}
		.footer { 
			background: #f9fafb; 
			padding: 24px; 
			text-align: center; 
			color: #6b7280;
			font-size: 14px;
		}
		.footer p {
			margin: 4px 0;
		}
		.divider {
			height: 1px;
			background: #e5e7eb;
			margin: 24px 0;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<svg class="logo" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
				<rect width="48" height="48" rx="12" fill="white" fill-opacity="0.2"/>
				<path d="M24 14L34 20V32L24 38L14 32V20L24 14Z" stroke="white" stroke-width="2" stroke-linejoin="round"/>
				<path d="M24 20V32" stroke="white" stroke-width="2"/>
				<path d="M14 20L24 26L34 20" stroke="white" stroke-width="2" stroke-linejoin="round"/>
			</svg>
			<h1>LibreServ</h1>
		</div>
		<div class="content">
			{{.Content}}
		</div>
		<div class="footer">
			<p><strong>LibreServ</strong></p>
			<p>Self-hosted application management</p>
			<p style="font-size: 12px; margin-top: 12px;">
				This email was sent from your LibreServ instance.
			</p>
		</div>
	</div>
</body>
</html>`

// RenderHTMLEmail renders ANY email using the universal LibreServ template
func RenderHTMLEmail(subject, plainTextBody string, data map[string]interface{}) (string, error) {
	tmpl, err := template.New("universal_email").Parse(UniversalEmailTemplate)
	if err != nil {
		return "", fmt.Errorf("failed to parse universal template: %w", err)
	}

	// Prepare data with formatted content
	formattedData := make(map[string]interface{})
	for k, v := range data {
		formattedData[k] = v
	}

	// Convert plain text body to HTML
	bodyStr := plainTextBody
	if bodyStr == "" {
		bodyStr = fmt.Sprintf("%v", data["body"])
	}
	
	// Smart conversion: detect buttons/links and format accordingly
	htmlContent := convertTextToHTML(bodyStr)
	formattedData["Content"] = htmlContent

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, formattedData); err != nil {
		return "", fmt.Errorf("failed to execute universal template: %w", err)
	}

	return buf.String(), nil
}

// convertTextToHTML converts plain text email body to HTML with smart formatting
func convertTextToHTML(text string) string {
	var html strings.Builder
	
	// Split by double newlines (paragraphs)
	paragraphs := strings.Split(text, "\n\n")
	
	for _, p := range paragraphs {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		
		// Check if paragraph contains a URL (for buttons)
		if strings.Contains(p, "http") {
			// Extract URL and text
			lines := strings.Split(p, "\n")
			for _, line := range lines {
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}
				if strings.Contains(line, "http") {
					// This is a link - make it a button
					url := extractURL(line)
					if url != "" {
						html.WriteString(fmt.Sprintf(`<a href="%s" class="button">Reset Password</a>`, url))
					} else {
						html.WriteString(fmt.Sprintf("<p>%s</p>", line))
					}
				} else {
					html.WriteString(fmt.Sprintf("<p>%s</p>", line))
				}
			}
		} else {
			// Regular paragraph - convert newlines to <br>
			html.WriteString(fmt.Sprintf("<p>%s</p>", strings.ReplaceAll(p, "\n", "<br>")))
		}
	}
	
	return html.String()
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
	if s.useTLS {
		return s.sendTLS(to, msg)
	}
	return smtp.SendMail(s.host, s.auth, s.from, to, []byte(msg))
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
