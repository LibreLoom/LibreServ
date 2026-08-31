package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

func TestSystemCheckUpdates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]interface{}{})
	}))
	t.Cleanup(srv.Close)

	checker := system.NewUpdateChecker(config.UpdatesConfig{
		BaseURL: srv.URL + "/api/v1",
		Owner:   "LibreLoom",
		Repo:    "LibreServ",
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
	checker := system.NewUpdateChecker(config.UpdatesConfig{
		BaseURL: "http://127.0.0.1:1/api/v1",
		Owner:   "x",
		Repo:    "y",
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

// Adapt to AuditLogger signature used by handlers — discover at compile time.
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
