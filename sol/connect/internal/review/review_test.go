package review

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAssessActionTypes(t *testing.T) {
	svc := NewReviewService()
	tests := []struct {
		actionType string
		risk       RiskLevel
		intrusive  Intrusiveness
		consent    bool
		scope      string
	}{
		{"read_file", RiskLow, IntrusivenessNone, true, "file"},
		{"read_directory", RiskLow, IntrusivenessNone, true, "directory"},
		{"run_command", RiskLow, IntrusivenessModerate, true, "credential"},
		{"modify_config", RiskMedium, IntrusivenessModerate, true, "file"},
		{"restart_service", RiskLow, IntrusivenessMinimal, false, ""},
		{"delete_file", RiskHigh, IntrusivenessSevere, true, "file"},
		{"rotate_credential", RiskMedium, IntrusivenessModerate, false, ""},
		{"view_logs", RiskLow, IntrusivenessNone, true, "file"},
		{"install_package", RiskHigh, IntrusivenessModerate, true, "credential"},
		{"unknown", RiskMedium, IntrusivenessModerate, true, "credential"},
	}

	for _, tt := range tests {
		t.Run(tt.actionType, func(t *testing.T) {
			action := Action{
				Type:        tt.actionType,
				Target:      "/tmp/example",
				Description: "perform test action",
				Parameters:  map[string]any{"command": "ls -la"},
			}
			got := svc.Assess(action)
			if got.RiskLevel != tt.risk || got.Intrusiveness != tt.intrusive ||
				got.RequiresConsent != tt.consent || got.ConsentScope != tt.scope {
				t.Fatalf("assessment = %#v", got)
			}
			if got.Reasoning == "" {
				t.Fatal("expected reasoning")
			}
		})
	}
}

func TestAssessDestructiveCommands(t *testing.T) {
	svc := NewReviewService()
	for _, command := range []string{
		"rm -rf /", "mkfs.ext4 /dev/sda", "dd if=/dev/zero", "shutdown now",
		"reboot", "halt", "echo x > /dev/sda", "format c:",
	} {
		got := svc.Assess(Action{
			Type:       "run_command",
			Target:     "server",
			Parameters: map[string]any{"command": command},
		})
		if got.RiskLevel != RiskCritical || got.Intrusiveness != IntrusivenessSevere {
			t.Errorf("%q assessment = %#v", command, got)
		}
		if len(got.Warnings) < 2 {
			t.Errorf("%q warnings = %v", command, got.Warnings)
		}
	}
}

func TestCommandRiskAndPermissionDialogs(t *testing.T) {
	svc := NewReviewService()
	if got := svc.assessCommandRisk("", nil); got != RiskMedium {
		t.Fatalf("nil command risk = %q", got)
	}
	if got := svc.assessCommandRisk("", map[string]any{"command": "echo hello"}); got != RiskMedium {
		t.Fatalf("ordinary command risk = %q", got)
	}

	for _, command := range []string{"ls", "cat file", "head file", "tail file", "grep x f", "find .", "ps aux", "top", "df -h", "du -sh .", "stat f", "file f", "whoami", "uname -a"} {
		if !isReadOnlyCommand(command) {
			t.Errorf("expected read-only: %q", command)
		}
	}
	if isReadOnlyCommand("echo ls") || isDestructiveCommand("echo safe") {
		t.Fatal("safe command was misclassified")
	}

	critical := svc.Assess(Action{
		Type:        "run_command",
		Target:      "device",
		Description: "erase disk",
		Parameters:  map[string]any{"command": "rm -rf /"},
	})
	dialog := svc.BuildPermissionDialog(critical)
	if len(dialog.Choices) != 2 || dialog.Choices[1].ID != "approve_limited" {
		t.Fatalf("critical choices = %#v", dialog.Choices)
	}
	if !strings.Contains(dialog.Message, "Warnings:") || !strings.Contains(dialog.Title, "run_command") {
		t.Fatalf("critical dialog = %#v", dialog)
	}

	normal := svc.BuildPermissionDialog(svc.Assess(Action{
		Type:        "read_file",
		Target:      "/tmp/file",
		Description: "read a file",
	}))
	if len(normal.Choices) != 3 || normal.Choices[1].ID != "approve_session" {
		t.Fatalf("normal choices = %#v", normal.Choices)
	}
	var decoded PermissionDialog
	if err := json.Unmarshal([]byte(normal.ToJSON()), &decoded); err != nil {
		t.Fatalf("decode dialog: %v", err)
	}
	if decoded.Assessment.Action.Target != "/tmp/file" {
		t.Fatalf("decoded dialog = %#v", decoded)
	}
}
