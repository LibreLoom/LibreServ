package security

import (
	"strings"
	"testing"
)

func TestEventValidate_ValidEvent(t *testing.T) {
	e := &Event{
		EventType:     EventLoginSuccess,
		Severity:      SeverityInfo,
		ActorID:       "user-1",
		ActorUsername: "alice",
		IPAddress:     "192.168.1.1",
		Details:       "Login successful",
	}
	if err := e.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestEventValidate_InvalidEventType(t *testing.T) {
	e := &Event{
		EventType: "nonexistent_event",
		Severity:  SeverityInfo,
	}
	err := e.Validate()
	if err == nil {
		t.Fatal("expected error for invalid event type")
	}
	if !strings.Contains(err.Error(), "invalid event type") {
		t.Errorf("error = %q, want 'invalid event type'", err.Error())
	}
}

func TestEventValidate_InvalidSeverity(t *testing.T) {
	e := &Event{
		EventType: EventLoginSuccess,
		Severity:  "extreme",
	}
	err := e.Validate()
	if err == nil {
		t.Fatal("expected error for invalid severity")
	}
	if !strings.Contains(err.Error(), "invalid severity") {
		t.Errorf("error = %q, want 'invalid severity'", err.Error())
	}
}

func TestEventValidate_TruncatesLongFields(t *testing.T) {
	e := &Event{
		EventType:     EventLoginSuccess,
		Severity:      SeverityInfo,
		ActorID:       strings.Repeat("b", MaxActorIDLength+50),
		ActorUsername: strings.Repeat("c", MaxActorUsernameLength+50),
		IPAddress:     strings.Repeat("d", MaxIPAddressLength+10),
		UserAgent:     strings.Repeat("e", MaxUserAgentLength+100),
		Details:       strings.Repeat("f", MaxDetailsLength+200),
	}
	if err := e.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(e.ActorID) > MaxActorIDLength {
		t.Errorf("ActorID not truncated: len=%d, max=%d", len(e.ActorID), MaxActorIDLength)
	}
	if len(e.ActorUsername) > MaxActorUsernameLength {
		t.Errorf("ActorUsername not truncated: len=%d, max=%d", len(e.ActorUsername), MaxActorUsernameLength)
	}
	if len(e.IPAddress) > MaxIPAddressLength {
		t.Errorf("IPAddress not truncated: len=%d, max=%d", len(e.IPAddress), MaxIPAddressLength)
	}
	if len(e.UserAgent) > MaxUserAgentLength {
		t.Errorf("UserAgent not truncated: len=%d, max=%d", len(e.UserAgent), MaxUserAgentLength)
	}
	if len(e.Details) > MaxDetailsLength {
		t.Errorf("Details not truncated: len=%d, max=%d", len(e.Details), MaxDetailsLength)
	}
}

func TestEventValidate_TruncatesMetadata(t *testing.T) {
	metadata := make(map[string]interface{})
	for i := 0; i < MaxMetadataKeys+10; i++ {
		metadata[strings.Repeat("k", i+1)] = strings.Repeat("v", MaxMetadataValueLength+100)
	}
	e := &Event{
		EventType: EventLoginSuccess,
		Severity:  SeverityInfo,
		Metadata:  metadata,
	}
	if err := e.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(e.Metadata) > MaxMetadataKeys {
		t.Errorf("metadata not truncated: len=%d, max=%d", len(e.Metadata), MaxMetadataKeys)
	}
}

func TestSeverityIsSeverityAtLeast(t *testing.T) {
	tests := []struct {
		severity Severity
		min      Severity
		want     bool
	}{
		{SeverityCritical, SeverityInfo, true},
		{SeverityCritical, SeverityWarning, true},
		{SeverityCritical, SeverityCritical, true},
		{SeverityWarning, SeverityInfo, true},
		{SeverityWarning, SeverityWarning, true},
		{SeverityWarning, SeverityCritical, false},
		{SeverityInfo, SeverityInfo, true},
		{SeverityInfo, SeverityWarning, false},
		{SeverityInfo, SeverityCritical, false},
	}

	for _, tt := range tests {
		name := string(tt.severity) + ">=" + string(tt.min)
		t.Run(name, func(t *testing.T) {
			if got := tt.severity.IsSeverityAtLeast(tt.min); got != tt.want {
				t.Errorf("IsSeverityAtLeast(%q, %q) = %v, want %v", tt.severity, tt.min, got, tt.want)
			}
		})
	}
}

func TestEventShouldNotify(t *testing.T) {
	settings := &UserSettings{
		NotificationsEnabled:   true,
		NotifyOnLogin:          false,
		NotifyOnFailedLogin:    true,
		NotifyOnPasswordChange: true,
		NotifyOnAdminAction:    true,
	}

	tests := []struct {
		eventType EventType
		want      bool
	}{
		{EventLoginSuccess, false},      // NotifyOnLogin=false
		{EventLoginFailed, true},        // NotifyOnFailedLogin=true
		{EventPasswordChanged, true},    // NotifyOnPasswordChange=true
		{EventPasswordReset, true},      // NotifyOnPasswordChange=true
		{EventAdminAction, true},        // NotifyOnAdminAction=true
		{EventUserCreated, true},        // NotifyOnAdminAction=true
		{EventAppInstalled, true},       // NotifyOnAdminAction=true
		{EventAccountLocked, true},      // Always notify for critical
		{EventSuspiciousActivity, true}, // Always notify for critical
		{EventBruteForceDetected, true}, // Always notify for critical
		{EventTokenReuse, true},         // Always notify for critical
		{EventTokenRevoked, true},       // Always notify for critical
		{EventAppStarted, false},        // Not covered by any setting
	}

	for _, tt := range tests {
		t.Run(string(tt.eventType), func(t *testing.T) {
			e := &Event{EventType: tt.eventType}
			if got := e.ShouldNotify(settings); got != tt.want {
				t.Errorf("ShouldNotify(%q) = %v, want %v", tt.eventType, got, tt.want)
			}
		})
	}
}

func TestEventShouldNotify_NotificationsDisabled(t *testing.T) {
	settings := &UserSettings{
		NotificationsEnabled: false,
		NotifyOnFailedLogin:  true,
	}
	e := &Event{EventType: EventLoginFailed}
	if e.ShouldNotify(settings) {
		t.Error("should not notify when notifications are disabled")
	}
}
