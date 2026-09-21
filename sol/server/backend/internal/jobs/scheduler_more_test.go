package jobs

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/notify"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

func TestSchedulerRunPeriodicStopsBeforeInitialRun(t *testing.T) {
	scheduler := NewScheduler(nil, nil, nil, "v1.0.0")
	close(scheduler.stopCh)
	called := false
	scheduler.wg.Add(1)
	scheduler.runPeriodic("test", time.Millisecond, func() { called = true })
	if called {
		t.Fatal("job should not run after scheduler stop")
	}
}

func TestSchedulerRunBackupSchedulesWithoutService(t *testing.T) {
	scheduler := NewScheduler(nil, nil, nil, "v1.0.0")
	scheduler.runBackupSchedules()
}

func TestSchedulerCheckSystemUpdates(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		response   string
	}{
		{
			name:       "update available",
			statusCode: http.StatusOK,
			response: `[{
				"tag_name":"v2.0.0",
				"name":"Version 2",
				"body":"Important fixes",
				"html_url":"https://example.com/releases/v2.0.0"
			}]`,
		},
		{name: "up to date", statusCode: http.StatusOK, response: `[]`},
		{name: "server error", statusCode: http.StatusInternalServerError, response: `{}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/repos/owner/repo/releases" {
					w.WriteHeader(tt.statusCode)
					_, _ = w.Write([]byte(tt.response))
					return
				}
				http.NotFound(w, r)
			}))
			defer server.Close()
			checker := system.NewUpdateChecker(config.UpdatesConfig{
				BaseURL: server.URL,
				Owner:   "owner",
				Repo:    "repo",
			})
			scheduler := NewScheduler(nil, checker, notify.NewService(nil, nil), "v1.0.0")
			scheduler.checkSystemUpdates()
		})
	}
}
