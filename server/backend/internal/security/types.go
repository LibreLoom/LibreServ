package security

import (
	"fmt"
	"time"
)

// Validation constants to prevent database bloat and attacks
const (
	MaxEventTypeLength     = 50
	MaxActorIDLength       = 100
	MaxActorUsernameLength = 100
	MaxIPAddressLength     = 45 // IPv6 max length
	MaxUserAgentLength     = 500
	MaxDetailsLength       = 2000
	MaxMetadataKeys        = 20
	MaxMetadataKeyLength   = 50
	MaxMetadataValueLength = 500
)

// EventType represents different types of security events
type EventType string

const (
	// Authentication events
	EventLoginSuccess    EventType = "login_success"
	EventLoginFailed     EventType = "login_failed"
	EventLogout          EventType = "logout"
	EventTokenRefresh    EventType = "token_refresh"
	EventTokenRevoked    EventType = "token_revoked"
	EventAccountLocked   EventType = "account_locked"
	EventAccountUnlocked EventType = "account_unlocked"
	EventPasswordChanged EventType = "password_changed"
	EventPasswordReset   EventType = "password_reset"

	// User management events
	EventUserCreated EventType = "user_created"
	EventUserUpdated EventType = "user_updated"
	EventUserDeleted EventType = "user_deleted"

	// Admin actions
	EventAdminAction     EventType = "admin_action"
	EventSettingsChanged EventType = "settings_changed"
	EventConfigChanged   EventType = "config_changed"

	// App events
	EventAppInstalled EventType = "app_installed"
	EventAppUpdated   EventType = "app_updated"
	EventAppRemoved   EventType = "app_removed"
	EventAppStarted   EventType = "app_started"
	EventAppStopped   EventType = "app_stopped"

	// Network events
	EventRouteCreated      EventType = "route_created"
	EventRouteUpdated      EventType = "route_updated"
	EventRouteDeleted      EventType = "route_deleted"
	EventDomainAdded       EventType = "domain_added"
	EventCertificateIssued EventType = "certificate_issued"

	// Security events
	EventSuspiciousActivity EventType = "suspicious_activity"
	EventBruteForceDetected EventType = "brute_force_detected"
	EventTokenReuse         EventType = "token_reuse"
)

// Severity represents the severity level of a security event
type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityCritical Severity = "critical"
)

// Event represents a security event
type Event struct {
	ID            int64                  `json:"id"`
	Timestamp     time.Time              `json:"timestamp"`
	EventType     EventType              `json:"event_type"`
	Severity      Severity               `json:"severity"`
	ActorID       string                 `json:"actor_id,omitempty"`
	ActorUsername string                 `json:"actor_username,omitempty"`
	IPAddress     string                 `json:"ip_address,omitempty"`
	UserAgent     string                 `json:"user_agent,omitempty"`
	Details       string                 `json:"details"`
	Metadata      map[string]interface{} `json:"metadata,omitempty"`
	Notified      bool                   `json:"notified"`
}

// truncateString safely truncates a string to maxLength
func truncateString(s string, maxLength int) string {
	if len(s) > maxLength {
		return s[:maxLength]
	}
	return s
}

// Validate checks if the event is valid and truncates fields that are too long
func (e *Event) Validate() error {
	// Validate and truncate string fields
	e.EventType = EventType(truncateString(string(e.EventType), MaxEventTypeLength))
	e.ActorID = truncateString(e.ActorID, MaxActorIDLength)
	e.ActorUsername = truncateString(e.ActorUsername, MaxActorUsernameLength)
	e.IPAddress = truncateString(e.IPAddress, MaxIPAddressLength)
	e.UserAgent = truncateString(e.UserAgent, MaxUserAgentLength)
	e.Details = truncateString(e.Details, MaxDetailsLength)

	// Validate event type
	validTypes := map[EventType]bool{
		EventLoginSuccess: true, EventLoginFailed: true, EventLogout: true,
		EventTokenRefresh: true, EventTokenRevoked: true, EventAccountLocked: true,
		EventAccountUnlocked: true, EventPasswordChanged: true, EventPasswordReset: true,
		EventUserCreated: true, EventUserUpdated: true, EventUserDeleted: true,
		EventAdminAction: true, EventSettingsChanged: true, EventConfigChanged: true,
		EventAppInstalled: true, EventAppUpdated: true, EventAppRemoved: true,
		EventAppStarted: true, EventAppStopped: true, EventRouteCreated: true,
		EventRouteUpdated: true, EventRouteDeleted: true, EventDomainAdded: true,
		EventCertificateIssued: true, EventSuspiciousActivity: true,
		EventBruteForceDetected: true, EventTokenReuse: true,
	}
	if !validTypes[e.EventType] {
		return fmt.Errorf("invalid event type: %s", e.EventType)
	}

	// Validate severity
	validSeverities := map[Severity]bool{
		SeverityInfo: true, SeverityWarning: true, SeverityCritical: true,
	}
	if !validSeverities[e.Severity] {
		return fmt.Errorf("invalid severity: %s", e.Severity)
	}

	// Validate and truncate metadata
	if len(e.Metadata) > MaxMetadataKeys {
		// Truncate metadata to max keys
		newMetadata := make(map[string]interface{})
		count := 0
		for k, v := range e.Metadata {
			if count >= MaxMetadataKeys {
				break
			}
			// Truncate key and value
			truncatedKey := truncateString(k, MaxMetadataKeyLength)
			var truncatedValue interface{}
			switch val := v.(type) {
			case string:
				truncatedValue = truncateString(val, MaxMetadataValueLength)
			default:
				truncatedValue = v
			}
			newMetadata[truncatedKey] = truncatedValue
			count++
		}
		e.Metadata = newMetadata
	}

	return nil
}

// UserSettings represents security notification settings for a user
type UserSettings struct {
	UserID                 string    `json:"user_id"`
	NotificationsEnabled   bool      `json:"notifications_enabled"`
	NotificationFrequency  string    `json:"notification_frequency"` // instant, normal, digest
	NotifyOnLogin          bool      `json:"notify_on_login"`
	NotifyOnFailedLogin    bool      `json:"notify_on_failed_login"`
	NotifyOnPasswordChange bool      `json:"notify_on_password_change"`
	NotifyOnAdminAction    bool      `json:"notify_on_admin_action"`
	Use12HourTime          bool      `json:"use_12_hour_time"`
	UpdatedAt              time.Time `json:"updated_at"`
}

// FailedLoginAttempt tracks a single failed login
type FailedLoginAttempt struct {
	ID        int64     `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	Username  string    `json:"username,omitempty"`
	IPAddress string    `json:"ip_address"`
	UserAgent string    `json:"user_agent,omitempty"`
	Reason    string    `json:"reason,omitempty"`
}

// EventFilter provides filtering options for listing events
type EventFilter struct {
	ActorID   string
	EventType EventType
	Severity  Severity
	Since     time.Time
	Limit     int
	Offset    int // Pagination offset
}

// PaginatedEvents represents a paginated list of events
type PaginatedEvents struct {
	Events     []Event `json:"events"`
	TotalCount int     `json:"total_count"`
	Limit      int     `json:"limit"`
	Offset     int     `json:"offset"`
	HasMore    bool    `json:"has_more"`
}

// NotificationFrequency represents how often to send notifications
type NotificationFrequency string

const (
	FrequencyInstant NotificationFrequency = "instant"
	FrequencyNormal  NotificationFrequency = "normal"
	FrequencyDigest  NotificationFrequency = "digest"
)

// IsSeverityAtLeast returns true if the severity is at least the given level
func (s Severity) IsSeverityAtLeast(min Severity) bool {
	severityOrder := map[Severity]int{
		SeverityInfo:     0,
		SeverityWarning:  1,
		SeverityCritical: 2,
	}
	return severityOrder[s] >= severityOrder[min]
}

// ShouldNotify returns true if this event type should trigger a notification based on settings
func (e *Event) ShouldNotify(settings *UserSettings) bool {
	if !settings.NotificationsEnabled {
		return false
	}

	switch e.EventType {
	case EventLoginSuccess:
		return settings.NotifyOnLogin
	case EventLoginFailed:
		return settings.NotifyOnFailedLogin
	case EventPasswordChanged, EventPasswordReset:
		return settings.NotifyOnPasswordChange
	case EventAdminAction, EventSettingsChanged, EventConfigChanged,
		EventUserCreated, EventUserUpdated, EventUserDeleted,
		EventAppInstalled, EventAppUpdated, EventAppRemoved,
		EventRouteCreated, EventRouteUpdated, EventRouteDeleted:
		return settings.NotifyOnAdminAction
	case EventAccountLocked, EventSuspiciousActivity, EventBruteForceDetected,
		EventTokenReuse, EventTokenRevoked:
		// Always notify for critical security events
		return true
	default:
		return false
	}
}
