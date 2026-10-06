package system

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

func TestSystemCheckUpdates(t *testing.T) {
	// A development build has no release version, so no feed is read.
	prev := Version
	Version = "dev"
	t.Cleanup(func() { Version = prev })

	checker := system.NewUpdateChecker(config.UpdatesConfig{
		FeedURL: "http://127.0.0.1:1/feeds/sol",
		Channel: "stable",
	})
	h := NewSystemHandler(checker)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system/updates/check", nil)
	h.CheckUpdates(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("check updates: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/system/updates/check?force=true", nil)
	h.CheckUpdates(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("force check: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSystemCheckUpdatesError(t *testing.T) {
	saved := Version
	Version = "1.0.0" // a release build; dev builds never fetch the feed
	t.Cleanup(func() { Version = saved })
	checker := system.NewUpdateChecker(config.UpdatesConfig{
		FeedURL: "http://127.0.0.1:1/feeds/sol",
		Channel: "stable",
	})
	h := NewSystemHandler(checker)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system/updates/check?force=true", nil)
	h.CheckUpdates(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rec.Code)
	}
}

type recordingAudit struct {
	actions []string
}

func (a *recordingAudit) Log(ctx interface{}, action, actorID, target, result, message string, meta map[string]interface{}) {
	a.actions = append(a.actions, action)
}

// Adapt to shared.AuditLogger signature used by handlers — discover at compile time.
func TestSystemRestartNow(t *testing.T) {
	checker := system.NewUpdateChecker(config.UpdatesConfig{})
	ch := make(chan system.RestartSignal, 1)
	checker.SetRestartChannel(ch)
	h := NewSystemHandler(checker)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/system/restart", nil)
	h.RestartNow(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("restart: %d %s", rec.Code, rec.Body.String())
	}
	select {
	case <-ch:
	default:
		t.Fatal("expected restart signal")
	}
}
