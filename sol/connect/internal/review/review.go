package review

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Action represents a staff action that needs review before execution.
type Action struct {
	Type        string         `json:"type"`         // e.g. "read_file", "run_command", "modify_config"
	Target      string         `json:"target"`       // what the action affects
	Description string         `json:"description"`  // plain-language description
	Parameters  map[string]any `json:"parameters"`   // action parameters
	RequestedBy string         `json:"requested_by"` // staff member
}

// RiskLevel is the assessed danger level of an action.
type RiskLevel string

const (
	RiskNone     RiskLevel = "none"     // no risk, safe to proceed
	RiskLow      RiskLevel = "low"      // minimal risk, proceed with caution
	RiskMedium   RiskLevel = "medium"   // moderate risk, confirm with user
	RiskHigh     RiskLevel = "high"     // significant risk, require explicit consent
	RiskCritical RiskLevel = "critical" // severe risk, require explicit consent + supervisor
)

// Intrusiveness is how invasive the action is to the user's system.
type Intrusiveness string

const (
	IntrusivenessNone     Intrusiveness = "none"     // read-only, no changes
	IntrusivenessMinimal  Intrusiveness = "minimal"  // trivial changes (e.g. restart service)
	IntrusivenessModerate Intrusiveness = "moderate" // changes config or data
	IntrusivenessSevere   Intrusiveness = "severe"   // destructive or irreversible
)

// Assessment is the review model's assessment of a staff action.
type Assessment struct {
	Action          Action        `json:"action"`
	RiskLevel       RiskLevel     `json:"risk_level"`
	Intrusiveness   Intrusiveness `json:"intrusiveness"`
	Reasoning       string        `json:"reasoning"`
	RequiresConsent bool          `json:"requires_consent"`
	ConsentScope    string        `json:"consent_scope,omitempty"` // file, directory, credential
	ConsentPath     string        `json:"consent_path,omitempty"`
	Warnings        []string      `json:"warnings,omitempty"`
}

// ReviewService assesses staff actions before they are executed.
// It uses rule-based heuristics to classify risk and intrusiveness.
// In production, this would call an AI review model; the interface is the same.
type ReviewService struct{}

// NewReviewService creates a review service.
func NewReviewService() *ReviewService {
	return &ReviewService{}
}

// Assess evaluates a staff action and returns an assessment.
func (s *ReviewService) Assess(action Action) Assessment {
	a := Assessment{
		Action:   action,
		Warnings: []string{},
	}

	// Rule-based risk assessment
	switch action.Type {
	case "read_file":
		a.RiskLevel = RiskLow
		a.Intrusiveness = IntrusivenessNone
		a.RequiresConsent = true
		a.ConsentScope = "file"
		a.ConsentPath = action.Target
		a.Reasoning = "Reading a file requires user consent because it may contain private data."

	case "read_directory":
		a.RiskLevel = RiskLow
		a.Intrusiveness = IntrusivenessNone
		a.RequiresConsent = true
		a.ConsentScope = "directory"
		a.ConsentPath = action.Target
		a.Reasoning = "Listing directory contents requires user consent because it reveals file structure."

	case "run_command":
		a.RiskLevel = s.assessCommandRisk(action.Target, action.Parameters)
		a.Intrusiveness = IntrusivenessModerate
		a.RequiresConsent = true
		a.ConsentScope = "credential"
		a.Reasoning = "Running commands on a user's device is inherently risky and always requires consent."
		if a.RiskLevel == RiskCritical {
			a.Warnings = append(a.Warnings, "This command may cause irreversible damage.")
		}

	case "modify_config":
		a.RiskLevel = RiskMedium
		a.Intrusiveness = IntrusivenessModerate
		a.RequiresConsent = true
		a.ConsentScope = "file"
		a.ConsentPath = action.Target
		a.Reasoning = "Modifying configuration changes how the user's system behaves."

	case "restart_service":
		a.RiskLevel = RiskLow
		a.Intrusiveness = IntrusivenessMinimal
		a.RequiresConsent = false
		a.Reasoning = "Restarting a service causes brief downtime but no data loss."

	case "delete_file":
		a.RiskLevel = RiskHigh
		a.Intrusiveness = IntrusivenessSevere
		a.RequiresConsent = true
		a.ConsentScope = "file"
		a.ConsentPath = action.Target
		a.Reasoning = "Deleting files is destructive and may be irreversible."
		a.Warnings = append(a.Warnings, "This action cannot be undone.")

	case "rotate_credential":
		a.RiskLevel = RiskMedium
		a.Intrusiveness = IntrusivenessModerate
		a.RequiresConsent = false
		a.Reasoning = "Rotating credentials is safe — old credentials are revoked and new ones issued."

	case "view_logs":
		a.RiskLevel = RiskLow
		a.Intrusiveness = IntrusivenessNone
		a.RequiresConsent = true
		a.ConsentScope = "file"
		a.ConsentPath = action.Target
		a.Reasoning = "Logs may contain sensitive information and require consent."

	case "install_package":
		a.RiskLevel = RiskHigh
		a.Intrusiveness = IntrusivenessModerate
		a.RequiresConsent = true
		a.ConsentScope = "credential"
		a.Reasoning = "Installing packages modifies the system and may introduce security risks."

	default:
		a.RiskLevel = RiskMedium
		a.Intrusiveness = IntrusivenessModerate
		a.RequiresConsent = true
		a.ConsentScope = "credential"
		a.Reasoning = "Unknown action type — defaulting to medium risk with consent required."
	}

	// Escalate risk if parameters contain dangerous patterns
	if action.Parameters != nil {
		if cmd, ok := action.Parameters["command"].(string); ok {
			if isDestructiveCommand(cmd) {
				a.RiskLevel = RiskCritical
				a.Intrusiveness = IntrusivenessSevere
				a.Warnings = append(a.Warnings, "Command pattern detected as potentially destructive.")
			}
		}
	}

	return a
}

// assessCommandRisk evaluates the risk of a specific command.
func (s *ReviewService) assessCommandRisk(target string, params map[string]any) RiskLevel {
	if cmd, ok := params["command"].(string); ok {
		if isDestructiveCommand(cmd) {
			return RiskCritical
		}
		if isReadOnlyCommand(cmd) {
			return RiskLow
		}
	}
	return RiskMedium
}

// isDestructiveCommand checks for patterns that indicate irreversible damage.
func isDestructiveCommand(cmd string) bool {
	lower := strings.ToLower(cmd)
	destructive := []string{"rm -rf", "mkfs", "dd if=", "shutdown", "reboot", "halt", "> /dev/sd", "format"}
	for _, d := range destructive {
		if strings.Contains(lower, d) {
			return true
		}
	}
	return false
}

// isReadOnlyCommand checks for patterns that are read-only.
func isReadOnlyCommand(cmd string) bool {
	lower := strings.ToLower(cmd)
	readOnly := []string{"ls", "cat", "head", "tail", "grep", "find", "ps", "top", "df", "du", "stat", "file", "whoami", "uname"}
	for _, r := range readOnly {
		if strings.HasPrefix(lower, r+" ") || lower == r {
			return true
		}
	}
	return false
}

// PermissionDialog represents the consent dialog shown to the user.
type PermissionDialog struct {
	Assessment Assessment `json:"assessment"`
	Title      string     `json:"title"`
	Message    string     `json:"message"`
	Choices    []Choice   `json:"choices"`
}

// Choice is a user-selectable option in the permission dialog.
type Choice struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Style string `json:"style"` // "primary", "danger", "neutral"
}

// BuildPermissionDialog creates the consent dialog for an assessment.
func (s *ReviewService) BuildPermissionDialog(a Assessment) PermissionDialog {
	dialog := PermissionDialog{
		Assessment: a,
		Title:      fmt.Sprintf("Staff action requires your approval: %s", a.Action.Type),
		Message:    s.buildDialogMessage(a),
		Choices:    s.buildChoices(a),
	}
	return dialog
}

func (s *ReviewService) buildDialogMessage(a Assessment) string {
	var sb strings.Builder
	sb.WriteString(a.Reasoning)
	sb.WriteString("\n\n")
	sb.WriteString(fmt.Sprintf("Action: %s\n", a.Action.Description))
	sb.WriteString(fmt.Sprintf("Target: %s\n", a.Action.Target))
	sb.WriteString(fmt.Sprintf("Risk level: %s\n", a.RiskLevel))
	sb.WriteString(fmt.Sprintf("Intrusiveness: %s\n", a.Intrusiveness))

	if len(a.Warnings) > 0 {
		sb.WriteString("\nWarnings:\n")
		for _, w := range a.Warnings {
			sb.WriteString(fmt.Sprintf("• %s\n", w))
		}
	}

	return sb.String()
}

func (s *ReviewService) buildChoices(a Assessment) []Choice {
	choices := []Choice{
		{ID: "deny", Label: "Deny", Style: "neutral"},
	}

	if a.RiskLevel == RiskCritical {
		choices = append(choices, Choice{ID: "approve_limited", Label: "Approve for 1 hour", Style: "danger"})
	} else {
		choices = append(choices, Choice{ID: "approve_session", Label: "Approve for this session", Style: "primary"})
		choices = append(choices, Choice{ID: "approve_always", Label: "Always allow this action", Style: "neutral"})
	}

	return choices
}

// MarshalJSON for PermissionDialog ensures clean serialization.
func (d PermissionDialog) ToJSON() string {
	b, _ := json.Marshal(d)
	return string(b)
}
