package security

import (
	"strings"
	"testing"
	"time"
)

// TestNotificationBodyIsPlainLanguage guards the plain-language rule for
// security notification emails: no raw event type codes, no RFC3339
// timestamps, no full IPs, and a what-to-do next for every event.
func TestNotificationBodyIsPlainLanguage(t *testing.T) {
	svc := &Service{}
	events := []Event{
		{EventType: EventLoginFailed, Timestamp: time.Date(2026, 8, 5, 14, 3, 0, 0, time.UTC), IPAddress: "192.168.1.42"},
		{EventType: EventAccountLocked, Timestamp: time.Date(2026, 8, 5, 14, 3, 0, 0, time.UTC)},
		{EventType: EventSuspiciousActivity, Timestamp: time.Date(2026, 8, 5, 14, 3, 0, 0, time.UTC), Details: "multiple failed logins\nfrom one address"},
		{EventType: EventUserCreated, Timestamp: time.Date(2026, 8, 5, 14, 3, 0, 0, time.UTC), ActorUsername: "alice"},
		{EventType: EventAppRemoved, Timestamp: time.Date(2026, 8, 5, 14, 3, 0, 0, time.UTC)},
	}

	for _, e := range events {
		body := svc.buildNotificationBody(&e)
		subject := svc.buildNotificationSubject(&e)

		if subject == "" || body == "" {
			t.Fatalf("empty subject/body for %s", e.EventType)
		}
		for _, raw := range []string{string(e.EventType), "2026-08-05T", "14:03:00", "192.168.1.42", "User Agent", "Event Type:"} {
			if strings.Contains(body, raw) {
				t.Fatalf("notification for %s leaks raw/technical text %q:\n%s", e.EventType, raw, body)
			}
		}
		// Every email must point to a concrete place in the UI.
		if !strings.Contains(body, "LibreServ →") {
			t.Fatalf("notification for %s has no UI path to act on:\n%s", e.EventType, body)
		}
	}
}
