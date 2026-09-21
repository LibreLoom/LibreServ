package apps

import (
	"net/http"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers/testutil"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func TestAppsHandlerCoverage(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.SeedApp(t, f, "installed-one")
	h := NewAppsHandler(f.Manager)
	h.SetAuditLogger(nil)
	h.SetSecurityEvents(nil)

	cases := []struct {
		name   string
		method string
		target string
		body   string
		params map[string]string
		fn     http.HandlerFunc
		want   int
	}{
		{"list", http.MethodGet, "/apps", "", nil, h.ListInstalledApps, http.StatusOK},
		{"get missing id", http.MethodGet, "/apps/", "", nil, h.GetInstalledApp, http.StatusBadRequest},
		{"get unknown", http.MethodGet, "/apps/nope", "", map[string]string{"instanceId": "nope"}, h.GetInstalledApp, http.StatusNotFound},
		{"get", http.MethodGet, "/apps/installed-one", "", map[string]string{"instanceId": "installed-one"}, h.GetInstalledApp, http.StatusOK},
		{"install bad json", http.MethodPost, "/apps", "{", nil, h.InstallApp, http.StatusBadRequest},
		{"install missing app", http.MethodPost, "/apps", `{}`, nil, h.InstallApp, http.StatusBadRequest},
		{"install unknown", http.MethodPost, "/apps", `{"app_id":"unknown"}`, nil, h.InstallApp, http.StatusBadRequest},
		{"install invalid config", http.MethodPost, "/apps", `{"app_id":"demo","config":{}}`, nil, h.InstallApp, http.StatusBadRequest},
		{"start missing", http.MethodPost, "/apps/x/start", "", nil, h.StartApp, http.StatusBadRequest},
		{"start unknown", http.MethodPost, "/apps/x/start", "", map[string]string{"instanceId": "unknown"}, h.StartApp, http.StatusNotFound},
		{"start", http.MethodPost, "/apps/x/start", "", map[string]string{"instanceId": "installed-one"}, h.StartApp, http.StatusOK},
		{"stop missing", http.MethodPost, "/apps/x/stop", "", nil, h.StopApp, http.StatusBadRequest},
		{"stop", http.MethodPost, "/apps/x/stop", "", map[string]string{"instanceId": "installed-one"}, h.StopApp, http.StatusOK},
		{"restart missing", http.MethodPost, "/apps/x/restart", "", nil, h.RestartApp, http.StatusBadRequest},
		{"restart", http.MethodPost, "/apps/x/restart", "", map[string]string{"instanceId": "installed-one"}, h.RestartApp, http.StatusOK},
		{"status missing", http.MethodGet, "/apps/x/status", "", nil, h.GetAppStatus, http.StatusBadRequest},
		{"status unknown", http.MethodGet, "/apps/x/status", "", map[string]string{"instanceId": "unknown"}, h.GetAppStatus, http.StatusNotFound},
		{"status", http.MethodGet, "/apps/x/status", "", map[string]string{"instanceId": "installed-one"}, h.GetAppStatus, http.StatusOK},
		{"all history", http.MethodGet, "/apps/updates/history", "", nil, h.GetUpdateHistory, http.StatusOK},
		{"app history missing", http.MethodGet, "/apps/x/updates/history", "", nil, h.GetAppUpdateHistory, http.StatusBadRequest},
		{"app history", http.MethodGet, "/apps/x/updates/history", "", map[string]string{"instanceId": "installed-one"}, h.GetAppUpdateHistory, http.StatusOK},
		{"available", http.MethodGet, "/apps/updates/available", "", nil, h.GetAvailableUpdates, http.StatusOK},
		{"pin missing", http.MethodPost, "/apps/x/pin", `{}`, nil, h.PinAppVersion, http.StatusBadRequest},
		{"pin bad json", http.MethodPost, "/apps/x/pin", `{`, map[string]string{"instanceId": "installed-one"}, h.PinAppVersion, http.StatusBadRequest},
		{"pin empty", http.MethodPost, "/apps/x/pin", `{}`, map[string]string{"instanceId": "installed-one"}, h.PinAppVersion, http.StatusBadRequest},
		{"pin", http.MethodPost, "/apps/x/pin", `{"version":"0.5.0"}`, map[string]string{"instanceId": "installed-one"}, h.PinAppVersion, http.StatusOK},
		{"update pinned", http.MethodPost, "/apps/x/update", "", map[string]string{"instanceId": "installed-one"}, h.UpdateApp, http.StatusConflict},
		{"update missing", http.MethodPost, "/apps/x/update", "", nil, h.UpdateApp, http.StatusBadRequest},
		{"unpin missing", http.MethodPost, "/apps/x/unpin", "", nil, h.UnpinAppVersion, http.StatusBadRequest},
		{"unpin", http.MethodPost, "/apps/x/unpin", "", map[string]string{"instanceId": "installed-one"}, h.UnpinAppVersion, http.StatusOK},
		{"info missing app", http.MethodGet, "/apps/x/info/y", "", nil, h.GetExposedInfoField, http.StatusBadRequest},
		{"info missing field", http.MethodGet, "/apps/x/info/y", "", map[string]string{"instanceId": "installed-one"}, h.GetExposedInfoField, http.StatusBadRequest},
		{"info unknown field", http.MethodGet, "/apps/x/info/y", "", map[string]string{"instanceId": "installed-one", "fieldName": "unknown"}, h.GetExposedInfoField, http.StatusNotFound},
		{"info", http.MethodGet, "/apps/x/info/y", "", map[string]string{"instanceId": "installed-one", "fieldName": "required_value"}, h.GetExposedInfoField, http.StatusOK},
		{"ports", http.MethodGet, "/apps/ports", "", nil, h.ListAllocatedPorts, http.StatusOK},
		{"reconfigure missing id", http.MethodPut, "/apps/x/config", `{}`, nil, h.ReconfigureApp, http.StatusBadRequest},
		{"reconfigure bad json", http.MethodPut, "/apps/x/config", `{`, map[string]string{"instanceId": "installed-one"}, h.ReconfigureApp, http.StatusBadRequest},
		{"reconfigure nil config", http.MethodPut, "/apps/x/config", `{}`, map[string]string{"instanceId": "installed-one"}, h.ReconfigureApp, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := testutil.CallHandler(t, tc.method, tc.target, tc.body, tc.params, tc.fn)
			if rec.Code != tc.want {
				t.Fatalf("got %d, want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}

	rec := testutil.CallHandler(t, http.MethodPost, "/apps", `{"app_id":"demo","name":"Fresh","config":{"required_value":"ok"}}`, nil, h.InstallApp)
	if rec.Code != http.StatusCreated {
		t.Fatalf("valid install: %d %s", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		_ = f.DB.QueryRow(`SELECT COUNT(*) FROM apps WHERE name = 'Fresh' AND status = 'running'`).Scan(&count)
		if count == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	rec = testutil.CallHandler(t, http.MethodPost, "/apps/x/acknowledge-revocation", "", nil, h.AcknowledgeRevocation)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ack missing: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodPost, "/apps/x/acknowledge-revocation", "", map[string]string{"instanceId": "installed-one"}, h.AcknowledgeRevocation)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("ack absent revocation: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodDelete, "/apps/x", "", map[string]string{"instanceId": "installed-one"}, h.UninstallApp)
	if rec.Code != http.StatusOK {
		t.Fatalf("uninstall: %d %s", rec.Code, rec.Body.String())
	}
}

func TestReposHandlerCoverage(t *testing.T) {
	f := testutil.NewFixture(t)

	repos := NewReposHandler(f.Manager, config.Get())
	for _, tc := range []struct {
		body string
		want int
	}{
		{"{", 400},
		{`{}`, 400},
		{`{"url":"git@example.test:repo"}`, 400},
	} {
		rec := testutil.CallHandler(t, http.MethodPost, "/repos", tc.body, nil, repos.AddRepo)
		if rec.Code != tc.want {
			t.Fatalf("add repo %q: %d", tc.body, rec.Code)
		}
	}
	rec := testutil.CallHandler(t, http.MethodGet, "/repos/status", "", nil, repos.GetReposStatus)
	if rec.Code != 200 {
		t.Fatalf("repo status: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodPost, "/repos/pull", "", nil, repos.PullRepos)
	if rec.Code != 500 {
		t.Fatalf("repo pull: %d", rec.Code)
	}
	for _, index := range []string{"bad", "-1", "99"} {
		rec = testutil.CallHandler(t, http.MethodDelete, "/repos/"+index, "", map[string]string{"index": index}, repos.RemoveRepo)
		want := 400
		if index == "99" {
			want = 404
		}
		if rec.Code != want {
			t.Fatalf("remove %q: %d", index, rec.Code)
		}
	}
}
