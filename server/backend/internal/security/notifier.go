package security

import (
	"fmt"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
)

// EmailNotifier implements the Notifier interface using SMTP
type EmailNotifier struct {
	getSender func() (*email.Sender, error)
}

// NewEmailNotifier creates a new email notifier
func NewEmailNotifier() *EmailNotifier {
	return &EmailNotifier{
		getSender: email.NewSender,
	}
}

// IsConfigured returns true if email is configured
func (n *EmailNotifier) IsConfigured() bool {
	sender, err := n.getSender()
	return err == nil && sender != nil
}

// SendNotification sends an email notification (HTML if possible, plaintext fallback)
func (n *EmailNotifier) SendNotification(recipients []string, subject, body string) error {
	sender, err := n.getSender()
	if err != nil {
		return fmt.Errorf("email not configured: %w", err)
	}

	htmlBody, htmlErr := email.RenderHTMLEmail(subject, body, map[string]interface{}{})
	if htmlErr == nil {
		return sender.SendHTMLEmail(recipients, subject, htmlBody)
	}

	return sender.Send(recipients, subject, body)
}

// SendSecurityAlert sends a formatted security alert email
func (n *EmailNotifier) SendSecurityAlert(recipients []string, event *Event) error {
	subject := fmt.Sprintf("[LibreServ Security] %s", getEventTitle(event))
	body := buildSecurityEmail(event)

	return n.SendNotification(recipients, subject, body)
}

// sanitizeEmailContent removes characters that could be misinterpreted in email content
func sanitizeEmailContent(value string) string {
	// Remove carriage returns and newlines to prevent email structure manipulation
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	// Replace multiple spaces with single space
	value = strings.Join(strings.Fields(value), " ")
	return value
}

// getEventTitle returns a user-friendly title for an event
func getEventTitle(event *Event) string {
	switch event.EventType {
	case EventLoginSuccess:
		return "Successful Login"
	case EventLoginFailed:
		return "Failed Login Attempt"
	case EventLogout:
		return "Logout"
	case EventAccountLocked:
		return "Account Locked"
	case EventPasswordChanged:
		return "Password Changed"
	case EventSuspiciousActivity:
		return "Suspicious Activity Detected"
	case EventBruteForceDetected:
		return "Brute Force Attack Detected"
	case EventTokenReuse:
		return "Suspicious Token Activity"
	case EventUserCreated:
		return "New User Created"
	case EventUserDeleted:
		return "User Deleted"
	case EventAppInstalled:
		return "App Installed"
	case EventAppRemoved:
		return "App Removed"
	case EventSettingsChanged:
		return "Settings Changed"
	default:
		return "Security Event"
	}
}

// buildSecurityEmail creates a user-friendly email body
func buildSecurityEmail(event *Event) string {
	var sb strings.Builder

	sb.WriteString("Hello,\n\n")

	// Event-specific message
	switch event.EventType {
	case EventLoginSuccess:
		sb.WriteString("Someone successfully logged in to your LibreServ account.\n\n")
		sb.WriteString(fmt.Sprintf("Time: %s\n", event.Timestamp.Format("Jan 2, 2006 at 3:04 PM")))
		sb.WriteString(fmt.Sprintf("IP Address: %s\n", anonymizeIPForEmail(event.IPAddress)))

	case EventLoginFailed:
		sb.WriteString("Someone tried to log in to your LibreServ account with an incorrect password.\n\n")
		sb.WriteString(fmt.Sprintf("Time: %s\n", event.Timestamp.Format("Jan 2, 2006 at 3:04 PM")))
		sb.WriteString(fmt.Sprintf("IP Address: %s\n", anonymizeIPForEmail(event.IPAddress)))
		if event.Details != "" {
			sb.WriteString(fmt.Sprintf("Reason: %s\n", sanitizeEmailContent(event.Details)))
		}

	case EventAccountLocked:
		sb.WriteString("Your LibreServ account has been temporarily locked due to multiple failed login attempts.\n\n")
		sb.WriteString(fmt.Sprintf("Time: %s\n", event.Timestamp.Format("Jan 2, 2006 at 3:04 PM")))
		sb.WriteString(fmt.Sprintf("IP Address: %s\n", anonymizeIPForEmail(event.IPAddress)))
		sb.WriteString("\nYour account will automatically unlock in 15 minutes.\n")
		sb.WriteString("If you didn't attempt to log in, someone may be trying to access your account.\n")

	case EventPasswordChanged:
		sb.WriteString("Your LibreServ password has been changed.\n\n")
		sb.WriteString(fmt.Sprintf("Time: %s\n", event.Timestamp.Format("Jan 2, 2006 at 3:04 PM")))
		sb.WriteString(fmt.Sprintf("IP Address: %s\n", anonymizeIPForEmail(event.IPAddress)))
		sb.WriteString("\nIf you didn't make this change, please contact support immediately.\n")

	case EventSuspiciousActivity:
		sb.WriteString("We've detected suspicious activity on your LibreServ server.\n\n")
		sb.WriteString(fmt.Sprintf("Time: %s\n", event.Timestamp.Format("Jan 2, 2006 at 3:04 PM")))
		sb.WriteString(fmt.Sprintf("Details: %s\n", sanitizeEmailContent(event.Details)))

	default:
		sb.WriteString("A security event occurred on your LibreServ server:\n\n")
		sb.WriteString(fmt.Sprintf("Event: %s\n", getEventTitle(event)))
		sb.WriteString(fmt.Sprintf("Time: %s\n", event.Timestamp.Format("Jan 2, 2006 at 3:04 PM")))
		sb.WriteString(fmt.Sprintf("Severity: %s\n", strings.ToUpper(string(event.Severity))))
		if event.Details != "" {
			sb.WriteString(fmt.Sprintf("Details: %s\n", sanitizeEmailContent(event.Details)))
		}
	}

	sb.WriteString("\n---\n\n")
	sb.WriteString("You can view your security activity in the LibreServ web interface:\n")
	sb.WriteString("LibreServ → Settings → Security → Activity Log\n\n")

	sb.WriteString("If you have any questions or concerns, please don't hesitate to reach out.\n\n")
	sb.WriteString("Best regards,\n")
	sb.WriteString("The LibreServ Team\n")

	return sb.String()
}

// anonymizeIPForEmail masks the IP for privacy
func anonymizeIPForEmail(ip string) string {
	if ip == "" {
		return "Unknown"
	}
	// Show first 3 octets for IPv4, first 4 groups for IPv6
	if strings.Contains(ip, ".") {
		parts := strings.Split(ip, ".")
		if len(parts) == 4 {
			return fmt.Sprintf("%s.%s.%s.***", parts[0], parts[1], parts[2])
		}
	}
	return "Hidden for privacy"
}
