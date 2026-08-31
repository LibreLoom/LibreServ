package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/audit"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	containerruntime "gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

type coverageRuntime struct {
	containers []containerruntime.ContainerInfo
	upErr      error
	stopErr    error
}

func (r *coverageRuntime) ComposeUp(context.Context, string) error   { return r.upErr }
func (r *coverageRuntime) ComposeDown(context.Context, string) error { return nil }
func (r *coverageRuntime) ComposePull(context.Context, string) error { return nil }
func (r *coverageRuntime) ComposeStop(context.Context, string) error { return r.stopErr }
func (r *coverageRuntime) ListContainersByLabel(context.Context, string) ([]containerruntime.ContainerInfo, error) {
	return r.containers, nil
}
func (r *coverageRuntime) ListContainersAll(context.Context) ([]containerruntime.ContainerInfo, error) {
	return r.containers, nil
}
func (r *coverageRuntime) GetContainerStats(context.Context, string) (*containerruntime.ContainerStats, error) {
	return &containerruntime.ContainerStats{}, nil
}
func (r *coverageRuntime) InspectContainer(context.Context, string) (*containerruntime.ContainerInspectResult, error) {
	return &containerruntime.ContainerInspectResult{}, nil
}
func (r *coverageRuntime) ContainerLogs(context.Context, string, containerruntime.LogOptions) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (r *coverageRuntime) FindContainersByInstanceID(context.Context, string) ([]containerruntime.ContainerInfo, error) {
	return r.containers, nil
}
func (r *coverageRuntime) HealthCheck() error { return nil }
func (r *coverageRuntime) Close() error       { return nil }

type coverageFixture struct {
	db      *database.DB
	manager *apps.Manager
	caddy   *network.CaddyManager
	runtime *coverageRuntime
}

func newCoverageFixture(t *testing.T) *coverageFixture {
	t.Helper()
	root := t.TempDir()
	catalogRoot := filepath.Join(root, "catalog")
	appDir := filepath.Join(catalogRoot, "apps", "demo")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	appYAML := `id: demo
name: Demo
description: Demo app
version: "2.0.0"
category: utility
deployment:
  image: demo:latest
  ports:
    - host: 19091
      container: 8080
      name: ui
configuration:
  - name: required_value
    label: Required value
    type: string
    required: true
  - name: generated_secret
    label: Generated secret
    type: password
    auto_generate: true
exposed_info:
  - name: required_value
    label: Required value
    type: string
    copyable: true
access_model: external
`
	if err := os.WriteFile(filepath.Join(appDir, "app.yaml"), []byte(appYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "docker-compose.yml.tmpl"), []byte("services:\n  demo:\n    image: demo:latest\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Server: config.ServerConfig{Host: "127.0.0.1", Port: 8080, Mode: "development"},
		Apps:   config.AppsConfig{CatalogPath: catalogRoot, DataPath: filepath.Join(root, "data")},
		Auth:   config.AuthConfig{JWTSecret: "coverage-jwt-secret", CSRFSecret: "coverage-csrf"},
		Network: config.NetworkConfig{Caddy: config.CaddyConfig{
			Mode:          "noop",
			ConfigPath:    filepath.Join(root, "Caddyfile"),
			DefaultDomain: "example.test",
			AutoHTTPS:     true,
		}},
	}
	previous := config.Get()
	config.SetTestConfig(cfg)
	t.Cleanup(func() { config.SetTestConfig(previous) })

	db, err := database.Open(filepath.Join(root, "coverage.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	caddy := network.NewCaddyManager(db, network.CaddyConfig{
		Mode:          "noop",
		ConfigPath:    cfg.Network.Caddy.ConfigPath,
		DefaultDomain: cfg.Network.Caddy.DefaultDomain,
		AutoHTTPS:     true,
	})
	if err := caddy.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	rt := &coverageRuntime{containers: []containerruntime.ContainerInfo{{
		ID: "container-1", Names: []string{"/demo"}, State: "running", Status: "Up",
	}}}
	manager, err := apps.NewManager(catalogRoot, cfg.Apps.DataPath, rt, db, nil, nil, caddy)
	if err != nil {
		t.Fatal(err)
	}
	return &coverageFixture{db: db, manager: manager, caddy: caddy, runtime: rt}
}

func seedCoverageApp(t *testing.T, f *coverageFixture, id string) {
	t.Helper()
	path := filepath.Join(config.Get().Apps.DataPath, id)
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "docker-compose.yml"), []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := f.db.Exec(`
		INSERT INTO apps
			(id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version)
		VALUES (?, 'Demo instance', 'repo', 'demo', ?, 'running', 'healthy',
		        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, '1.0.0')`,
		id, path, `{"required_value":"visible","version":"1.0.0","route_id":"route-one"}`)
	if err != nil {
		t.Fatal(err)
	}
	f.manager.RegisterBackend(id, "http://127.0.0.1:19091")
}

func callCoverageHandler(t *testing.T, method, target, body string, params map[string]string, fn http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	routeContext := chi.NewRouteContext()
	for key, value := range params {
		routeContext.URLParams.Add(key, value)
	}
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
	fn(rec, req)
	return rec
}

func TestAppsHandlerCoverage(t *testing.T) {
	f := newCoverageFixture(t)
	seedCoverageApp(t, f, "installed-one")
	h := NewAppsHandler(f.manager)
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
			rec := callCoverageHandler(t, tc.method, tc.target, tc.body, tc.params, tc.fn)
			if rec.Code != tc.want {
				t.Fatalf("got %d, want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}

	rec := callCoverageHandler(t, http.MethodPost, "/apps", `{"app_id":"demo","name":"Fresh","config":{"required_value":"ok"}}`, nil, h.InstallApp)
	if rec.Code != http.StatusCreated {
		t.Fatalf("valid install: %d %s", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		_ = f.db.QueryRow(`SELECT COUNT(*) FROM apps WHERE name = 'Fresh' AND status = 'running'`).Scan(&count)
		if count == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	rec = callCoverageHandler(t, http.MethodPost, "/apps/x/acknowledge-revocation", "", nil, h.AcknowledgeRevocation)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ack missing: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodPost, "/apps/x/acknowledge-revocation", "", map[string]string{"instanceId": "installed-one"}, h.AcknowledgeRevocation)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("ack absent revocation: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodDelete, "/apps/x", "", map[string]string{"instanceId": "installed-one"}, h.UninstallApp)
	if rec.Code != http.StatusOK {
		t.Fatalf("uninstall: %d %s", rec.Code, rec.Body.String())
	}
}

func TestNetworkHandlersCoverage(t *testing.T) {
	f := newCoverageFixture(t)
	h := NewNetworkHandlers(f.caddy, f.manager)
	if h.WithACME(nil) != h {
		t.Fatal("WithACME should return receiver")
	}

	for _, tc := range []struct {
		name, method, target, body string
		params                     map[string]string
		fn                         http.HandlerFunc
		want                       int
	}{
		{"status", http.MethodGet, "/network/status", "", nil, h.GetCaddyStatus, 200},
		{"list", http.MethodGet, "/network/routes", "", nil, h.ListRoutes, 200},
		{"get missing", http.MethodGet, "/network/routes/x", "", nil, h.GetRoute, 400},
		{"get unknown", http.MethodGet, "/network/routes/x", "", map[string]string{"routeID": "x"}, h.GetRoute, 404},
		{"check bad", http.MethodPost, "/network/routes/check", "{", nil, h.CheckRouteAvailability, 400},
		{"check empty", http.MethodPost, "/network/routes/check", `{}`, nil, h.CheckRouteAvailability, 400},
		{"check", http.MethodPost, "/network/routes/check", `{"subdomain":"free"}`, nil, h.CheckRouteAvailability, 200},
		{"create bad", http.MethodPost, "/network/routes", "{", nil, h.CreateRoute, 400},
		{"create empty", http.MethodPost, "/network/routes", `{}`, nil, h.CreateRoute, 400},
		{"create no backend", http.MethodPost, "/network/routes", `{"subdomain":"demo"}`, nil, h.CreateRoute, 400},
		{"update missing", http.MethodPut, "/network/routes/x", `{}`, nil, h.UpdateRoute, 400},
		{"delete missing", http.MethodDelete, "/network/routes/x", "", nil, h.DeleteRoute, 400},
		{"caddyfile", http.MethodGet, "/network/caddyfile", "", nil, h.GetCaddyfile, 200},
		{"test bad", http.MethodPost, "/network/test", "{", nil, h.TestBackend, 400},
		{"test empty", http.MethodPost, "/network/test", `{}`, nil, h.TestBackend, 400},
		{"test unreachable", http.MethodPost, "/network/test", `{"backend":"127.0.0.1:1"}`, nil, h.TestBackend, 200},
		{"forwarding", http.MethodGet, "/network/forwarding", "", nil, h.GetPortForwardingStatus, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := callCoverageHandler(t, tc.method, tc.target, tc.body, tc.params, tc.fn)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}

	rec := callCoverageHandler(t, http.MethodPost, "/network/routes", `{"subdomain":"demo","backend":"http://127.0.0.1:19091","app_id":"installed"}`, nil, h.CreateRoute)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create route: %d %s", rec.Code, rec.Body.String())
	}
	var route network.Route
	if err := jsonDecode(rec.Body.Bytes(), &route); err != nil {
		t.Fatal(err)
	}

	rec = callCoverageHandler(t, http.MethodGet, "/network/routes/"+route.ID, "", map[string]string{"routeID": route.ID}, h.GetRoute)
	if rec.Code != http.StatusOK {
		t.Fatalf("get route: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodPost, "/network/routes", `{"subdomain":"demo","backend":"http://127.0.0.1:19091"}`, nil, h.CreateRoute)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate route: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodPut, "/network/routes/"+route.ID, "{", map[string]string{"routeID": route.ID}, h.UpdateRoute)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad update: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodPut, "/network/routes/"+route.ID, `{"backend":"http://127.0.0.1:19092","enabled":true}`, map[string]string{"routeID": route.ID}, h.UpdateRoute)
	if rec.Code != http.StatusOK {
		t.Fatalf("update route: %d %s", rec.Code, rec.Body.String())
	}
	rec = callCoverageHandler(t, http.MethodDelete, "/network/routes/"+route.ID, "", map[string]string{"routeID": route.ID}, h.DeleteRoute)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete route: %d %s", rec.Code, rec.Body.String())
	}

	nilHandler := NewNetworkHandlers(nil, nil)
	rec = callCoverageHandler(t, http.MethodPost, "/network/disconnect", "", nil, nilHandler.DisconnectDomain)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("nil disconnect: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodPost, "/network/disconnect", "", nil, h.DisconnectDomain)
	if rec.Code != http.StatusOK {
		t.Fatalf("disconnect: %d %s", rec.Code, rec.Body.String())
	}
}

func jsonDecode(data []byte, dest any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	return decoder.Decode(dest)
}

type coverageJobQueue struct {
	job *jobqueue.Job
	err error
}

func (q *coverageJobQueue) Enqueue(jobqueue.JobType, string, string, string, jobqueue.JobPriority) (jobqueue.JobInfo, error) {
	if q.err != nil {
		return nil, q.err
	}
	return q.job, nil
}
func (q *coverageJobQueue) GetJob(context.Context, string) (jobqueue.JobInfo, error) {
	return q.job, q.err
}
func (q *coverageJobQueue) GetLatestJob(context.Context, string, jobqueue.JobType) (jobqueue.JobInfo, error) {
	return q.job, q.err
}

func TestACMEHandlerCoverage(t *testing.T) {
	f := newCoverageFixture(t)
	manager := network.NewACMEManager("", filepath.Join(t.TempDir(), "Caddyfile"))
	h := NewACMEHandler(f.db, manager, nil, f.manager)
	if h.WithJobQueue(&coverageJobQueue{job: &jobqueue.Job{ID: "queued", Status: jobqueue.JobStatusQueued}}) != h {
		t.Fatal("WithJobQueue should return receiver")
	}

	for _, tc := range []struct {
		name, method, target, body string
		params                     map[string]string
		fn                         http.HandlerFunc
		want                       int
	}{
		{"dns invalid", http.MethodPost, "/acme/dns", `{}`, nil, h.ProbeDNS, 400},
		{"dns localhost", http.MethodPost, "/acme/dns", `{"host":"localhost"}`, nil, h.ProbeDNS, 200},
		{"ports invalid", http.MethodPost, "/acme/ports", `{}`, nil, h.ProbePorts, 400},
		{"ports", http.MethodPost, "/acme/ports", `{"host":"127.0.0.1","ports":[1,2]}`, nil, h.ProbePorts, 200},
		{"request invalid", http.MethodPost, "/acme/request", `{}`, nil, h.RequestCert, 400},
		{"request no email", http.MethodPost, "/acme/request", `{"domain":"cert.example.test"}`, nil, h.RequestCert, 400},
		{"request queued", http.MethodPost, "/acme/request", `{"domain":"cert.example.test","email":"admin@example.test"}`, nil, h.RequestCert, 202},
		{"get missing id", http.MethodGet, "/acme/jobs/x", "", nil, h.GetJob, 400},
		{"get unknown", http.MethodGet, "/acme/jobs/x", "", map[string]string{"jobID": "x"}, h.GetJob, 404},
		{"status missing domain", http.MethodGet, "/acme/status", "", nil, h.GetStatus, 400},
		{"status unknown", http.MethodGet, "/acme/status?domain=none.example.test", "", nil, h.GetStatus, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := callCoverageHandler(t, tc.method, tc.target, tc.body, tc.params, tc.fn)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}

	job, err := network.CreateACMEJob(context.Background(), f.db, "stored.example.test", "admin@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	rec := callCoverageHandler(t, http.MethodGet, "/acme/jobs/"+job.ID, "", map[string]string{"jobID": job.ID}, h.GetJob)
	if rec.Code != 200 {
		t.Fatalf("get stored: %d %s", rec.Code, rec.Body.String())
	}
	rec = callCoverageHandler(t, http.MethodGet, "/acme/status?domain=stored.example.test", "", nil, h.GetStatus)
	if rec.Code != 200 {
		t.Fatalf("stored status: %d %s", rec.Code, rec.Body.String())
	}

	nilHandler := NewACMEHandler(nil, nil, nil, nil)
	for _, fn := range []http.HandlerFunc{nilHandler.GetJob, nilHandler.GetStatus} {
		rec = callCoverageHandler(t, http.MethodGet, "/", "", nil, fn)
		if rec.Code != 500 {
			t.Fatalf("nil database: %d", rec.Code)
		}
	}
	if _, err := nilHandler.EnqueueIssue(context.Background(), "x.test", "a@b.test"); err == nil {
		t.Fatal("expected missing manager error")
	}
	nilHandler.manager = manager
	if _, err := nilHandler.EnqueueIssue(context.Background(), "x.test", "a@b.test"); err == nil {
		t.Fatal("expected missing database error")
	}
}

func TestOIDCHandlerCoverage(t *testing.T) {
	f := newCoverageFixture(t)
	seedCoverageApp(t, f, "oidc-app")
	if _, err := f.db.Exec(`
		INSERT INTO routes
			(id, subdomain, domain, backend, app_id, ssl, enabled, restricted_access, created_at, updated_at)
		VALUES ('route-one', 'oidc', 'example.test', 'http://127.0.0.1:19091',
		        'oidc-app', 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(f.db, "coverage-oidc-secret", logger)
	user, err := authSvc.Register(context.Background(), &auth.RegisterRequest{
		Username: "oidc-user",
		Password: "VeryStrongPassword123",
		Email:    "oidc@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	h := NewOIDCHandler(f.db, f.manager, authSvc, "https://issuer.example.test", logger)

	rec := callCoverageHandler(t, http.MethodGet, "/apps/oidc-app/oidc", "", map[string]string{"instanceId": "oidc-app"}, h.GetOIDCClient)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"configured":false`) {
		t.Fatalf("unconfigured client: %d %s", rec.Code, rec.Body.String())
	}
	clientID, secret, err := ProvisionOIDCClient(f.db, "oidc-app", "demo", []string{"https://demo.example.test/callback"}, h.issuerURL, logger)
	if err != nil || clientID == "" || secret == "" || len(randomHex(4)) != 8 {
		t.Fatalf("provision client: id=%q secret=%q err=%v", clientID, secret, err)
	}
	rec = callCoverageHandler(t, http.MethodGet, "/apps/oidc-app/oidc", "", map[string]string{"instanceId": "oidc-app"}, h.GetOIDCClient)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"configured":true`) {
		t.Fatalf("configured client: %d %s", rec.Code, rec.Body.String())
	}
	rec = callCoverageHandler(t, http.MethodGet, "/apps/oidc-app/oidc/access", "", map[string]string{"instanceId": "oidc-app"}, h.ListAccess)
	if rec.Code != 200 {
		t.Fatalf("empty access: %d", rec.Code)
	}

	for _, body := range []string{"{", `{}`} {
		rec = callCoverageHandler(t, http.MethodPost, "/access", body, map[string]string{"instanceId": "oidc-app"}, h.GrantAccess)
		if rec.Code != 400 {
			t.Fatalf("invalid grant %q: %d", body, rec.Code)
		}
	}
	rec = callCoverageHandler(t, http.MethodPost, "/access", fmt.Sprintf(`{"user_id":%q}`, user.ID), map[string]string{"instanceId": "oidc-app"}, h.GrantAccess)
	if rec.Code != 200 {
		t.Fatalf("grant: %d %s", rec.Code, rec.Body.String())
	}
	rec = callCoverageHandler(t, http.MethodGet, "/access", "", map[string]string{"instanceId": "oidc-app"}, h.ListAccess)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "oidc-user") {
		t.Fatalf("list access: %d %s", rec.Code, rec.Body.String())
	}
	rec = callCoverageHandler(t, http.MethodDelete, "/access/missing", "", map[string]string{"instanceId": "oidc-app", "userId": "missing"}, h.RevokeAccess)
	if rec.Code != 404 {
		t.Fatalf("revoke missing: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodDelete, "/access/"+user.ID, "", map[string]string{"instanceId": "oidc-app", "userId": user.ID}, h.RevokeAccess)
	if rec.Code != 200 {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body.String())
	}

	rec = callCoverageHandler(t, http.MethodGet, "/forward", "", nil, h.ForwardAuth)
	if rec.Code != http.StatusFound {
		t.Fatalf("forward no cookie: %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/forward", nil)
	req.AddCookie(&http.Cookie{Name: "libreserv_access", Value: "bad-token"})
	rec = httptest.NewRecorder()
	h.ForwardAuth(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("forward bad cookie: %d", rec.Code)
	}

	if _, err := h.getRouteByDomain("unknown.example.test"); err == nil {
		t.Fatal("expected unknown route")
	}
	rec = callCoverageHandler(t, http.MethodPut, "/restricted", "{", map[string]string{"instanceId": "oidc-app"}, h.ToggleRestrictedAccess)
	if rec.Code != 400 {
		t.Fatalf("bad toggle: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodPut, "/restricted", `{"restricted_access":true}`, map[string]string{"instanceId": "missing"}, h.ToggleRestrictedAccess)
	if rec.Code != 404 {
		t.Fatalf("missing app toggle: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodPut, "/restricted", `{"restricted_access":true}`, map[string]string{"instanceId": "oidc-app"}, h.ToggleRestrictedAccess)
	if rec.Code != 200 {
		t.Fatalf("toggle: %d %s", rec.Code, rec.Body.String())
	}
	rec = callCoverageHandler(t, http.MethodGet, "/restricted", "", map[string]string{"instanceId": "oidc-app"}, h.GetRestrictedAccess)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "true") {
		t.Fatalf("get restricted: %d %s", rec.Code, rec.Body.String())
	}
	rec = callCoverageHandler(t, http.MethodGet, "/restricted", "", map[string]string{"instanceId": "missing"}, h.GetRestrictedAccess)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "false") {
		t.Fatalf("missing restricted: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSmallHandlersCoverage(t *testing.T) {
	f := newCoverageFixture(t)

	repos := NewReposHandler(f.manager, config.Get())
	for _, tc := range []struct {
		body string
		want int
	}{
		{"{", 400},
		{`{}`, 400},
		{`{"url":"git@example.test:repo"}`, 400},
	} {
		rec := callCoverageHandler(t, http.MethodPost, "/repos", tc.body, nil, repos.AddRepo)
		if rec.Code != tc.want {
			t.Fatalf("add repo %q: %d", tc.body, rec.Code)
		}
	}
	rec := callCoverageHandler(t, http.MethodGet, "/repos/status", "", nil, repos.GetReposStatus)
	if rec.Code != 200 {
		t.Fatalf("repo status: %d", rec.Code)
	}
	rec = callCoverageHandler(t, http.MethodPost, "/repos/pull", "", nil, repos.PullRepos)
	if rec.Code != 500 {
		t.Fatalf("repo pull: %d", rec.Code)
	}
	for _, index := range []string{"bad", "-1", "99"} {
		rec = callCoverageHandler(t, http.MethodDelete, "/repos/"+index, "", map[string]string{"index": index}, repos.RemoveRepo)
		want := 400
		if index == "99" {
			want = 404
		}
		if rec.Code != want {
			t.Fatalf("remove %q: %d", index, rec.Code)
		}
	}

	connectivity := NewConnectivityHandler(nil, f.manager, f.caddy)
	for _, tc := range []struct {
		resp ConnectivityResponse
		want string
	}{
		{ConnectivityResponse{Domain: DomainStatus{Configured: true, HTTPS: true}}, "active"},
		{ConnectivityResponse{Tunnel: TunnelStatusSimple{Enabled: true}}, "active"},
		{ConnectivityResponse{NATType: "cgnat"}, "blocked"},
		{ConnectivityResponse{NATType: "symmetric"}, "blocked"},
		{ConnectivityResponse{NATType: "blocked"}, "blocked"},
		{ConnectivityResponse{NATType: "open"}, "local_only"},
		{ConnectivityResponse{NATType: "unknown"}, "local_only"},
	} {
		if got := connectivity.deriveRemoteAccess(tc.resp); got != tc.want {
			t.Fatalf("derive %q: got %q want %q", tc.resp.NATType, got, tc.want)
		}
		tc.resp.RemoteAccess = tc.want
		_ = connectivity.generateSuggestions(tc.resp)
	}
	rec = callCoverageHandler(t, http.MethodGet, "/connectivity", "", nil, connectivity.GetStatus)
	if rec.Code != 200 {
		t.Fatalf("connectivity status: %d %s", rec.Code, rec.Body.String())
	}

	tunnelService := network.NewTunnelService(network.TunnelConfig{}, t.TempDir())
	tunnel := NewTunnelHandler(tunnelService, nil, nil)
	rec = callCoverageHandler(t, http.MethodGet, "/tunnel", "", nil, tunnel.GetStatus)
	if rec.Code != 200 {
		t.Fatalf("tunnel status: %d", rec.Code)
	}
	for _, body := range []string{"{", `{}`} {
		rec = callCoverageHandler(t, http.MethodPost, "/tunnel/enable", body, nil, tunnel.Enable)
		if rec.Code != 400 {
			t.Fatalf("invalid tunnel %q: %d", body, rec.Code)
		}
	}
	rec = callCoverageHandler(t, http.MethodPost, "/tunnel/disable", "", nil, tunnel.Disable)
	if rec.Code != 200 {
		t.Fatalf("disable tunnel: %d %s", rec.Code, rec.Body.String())
	}
	rec = callCoverageHandler(t, http.MethodPost, "/tunnel/delete", "", nil, tunnel.Delete)
	if rec.Code != 200 {
		t.Fatalf("delete tunnel: %d %s", rec.Code, rec.Body.String())
	}
}

func requestWithCoverageUser(req *http.Request, id, username, role string) *http.Request {
	user := &middleware.User{ID: id, Username: username, Role: role}
	ctx := context.WithValue(req.Context(), middleware.UserContextKey, user)
	ctx = context.WithValue(ctx, middleware.UserIDContextKey, id)
	return req.WithContext(ctx)
}

func TestMonitoringHandlersCoverage(t *testing.T) {
	h := newTestMonitoringHandlers(t)

	tracker := NewFailureTracker()
	if tracker.RecordFailure("database") != 1 || tracker.RecordFailure("database") != 2 {
		t.Fatal("failure tracker did not increment")
	}
	if !tracker.CanAlert("database") {
		t.Fatal("new failure should be alertable")
	}
	tracker.RecordAlert("database")
	if tracker.CanAlert("database") {
		t.Fatal("recent alert should be throttled")
	}
	tracker.RecordSuccess("database")

	cache := NewHealthCheckCache(time.Hour)
	if cache.Get() != nil || !cache.ShouldRefresh() {
		t.Fatal("empty cache should require refresh")
	}
	cachedResult := &ComprehensiveHealthResponse{Status: "healthy", OverallPass: true}
	cache.Set(cachedResult)
	if cache.Get() != cachedResult || cache.ShouldRefresh() {
		t.Fatal("fresh cache was not returned")
	}

	for _, tc := range []struct {
		name, method, target, body string
		params                     map[string]string
		fn                         http.HandlerFunc
		want                       int
	}{
		{"health missing", http.MethodGet, "/apps/x/health", "", nil, h.GetAppHealth, 400},
		{"health", http.MethodGet, "/apps/x/health", "", map[string]string{"appID": "unknown"}, h.GetAppHealth, 200},
		{"metrics missing", http.MethodGet, "/apps/x/metrics", "", nil, h.GetAppMetrics, 400},
		{"metrics unavailable", http.MethodGet, "/apps/x/metrics", "", map[string]string{"appID": "unknown"}, h.GetAppMetrics, 503},
		{"history missing", http.MethodGet, "/apps/x/metrics/history", "", nil, h.GetMetricsHistory, 400},
		{"history", http.MethodGet, "/apps/x/metrics/history?since=bad&limit=9999", "", map[string]string{"appID": "unknown"}, h.GetMetricsHistory, 200},
		{"register missing", http.MethodPost, "/apps/x/health", `{}`, nil, h.RegisterHealthCheck, 400},
		{"register bad", http.MethodPost, "/apps/x/health", `{`, map[string]string{"appID": "unknown"}, h.RegisterHealthCheck, 400},
		{"register", http.MethodPost, "/apps/x/health", `{"http":{"url":"http://127.0.0.1:1","method":"GET","expected_status":200},"interval_seconds":30,"timeout_seconds":1,"failure_threshold":2,"success_threshold":1}`, map[string]string{"appID": "unknown"}, h.RegisterHealthCheck, 200},
		{"unregister missing", http.MethodDelete, "/apps/x/health", "", nil, h.UnregisterHealthCheck, 400},
		{"unregister", http.MethodDelete, "/apps/x/health", "", map[string]string{"appID": "unknown"}, h.UnregisterHealthCheck, 200},
		{"system", http.MethodGet, "/monitoring/system", "", nil, h.SystemHealth, 200},
		{"cleanup default", http.MethodPost, "/monitoring/cleanup", "", nil, h.CleanupMetrics, 200},
		{"cleanup custom", http.MethodPost, "/monitoring/cleanup?retention_days=2", "", nil, h.CleanupMetrics, 200},
		{"email invalid", http.MethodPost, "/monitoring/email", `{}`, nil, h.SendTestEmail, 400},
		{"prometheus", http.MethodGet, "/metrics", "", nil, h.PrometheusMetrics, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := callCoverageHandler(t, tc.method, tc.target, tc.body, tc.params, tc.fn)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}

	for _, method := range []string{http.MethodGet, http.MethodPost} {
		rec := callCoverageHandler(t, method, "/health/check", "", nil, h.ComprehensiveHealthCheck)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("comprehensive %s: %d %s", method, rec.Code, rec.Body.String())
		}
	}

	for _, value := range []uint64{1, 1024, 1024 * 1024, 5 * 1024 * 1024 * 1024} {
		if formatBytes(value) == "" {
			t.Fatal("formatBytes returned empty")
		}
	}
	if ok, _, _ := checkPathWritableHealth(t.TempDir(), config.Get()); !ok {
		t.Fatal("temporary directory should be writable")
	}
	if ok, _, _ := checkPathWritableHealth(filepath.Join(t.TempDir(), "new"), config.Get()); !ok {
		t.Fatal("new temporary directory should be writable")
	}

	failed := &ComprehensiveHealthResponse{
		Status:      "unhealthy",
		OverallPass: false,
		Checks: map[string]*HealthCheckResult{
			"runtime":  {Status: "failed"},
			"database": {Status: "passed"},
		},
	}
	h.trackFailuresAndAlert(failed)
	h.trackFailuresAndAlert(failed)
	h.trackFailuresAndAlert(failed)

	h.mailer = nil
	rec := callCoverageHandler(t, http.MethodPost, "/monitoring/email", `{"to":"person@example.test"}`, nil, h.SendTestEmail)
	if rec.Code != 500 {
		t.Fatalf("nil mailer: %d", rec.Code)
	}
}

func TestSettingsAndSecurityHandlersCoverage(t *testing.T) {
	f := newCoverageFixture(t)
	settingsService := settings.NewService(f.db.SQL())
	securityService := security.NewService(f.db, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	t.Cleanup(securityService.Close)
	authService := auth.NewService(f.db, "coverage-settings-secret", slog.Default())
	user, err := authService.Register(context.Background(), &auth.RegisterRequest{
		Username: "settings-user",
		Password: "SettingsPassword123",
		Email:    "settings@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}

	h := NewSettingsHandler(settingsService, securityService)
	userRequest := func(method, target, body, role string) *http.Request {
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		return requestWithCoverageUser(req, user.ID, user.Username, role)
	}
	call := func(req *http.Request, fn http.HandlerFunc) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		fn(rec, req)
		return rec
	}

	for _, fn := range []http.HandlerFunc{h.Get, h.GetProxy, h.GetNotifications, h.GetAISupport} {
		rec := call(httptest.NewRequest(http.MethodGet, "/", nil), fn)
		if rec.Code != 200 {
			t.Fatalf("settings get: %d %s", rec.Code, rec.Body.String())
		}
	}
	for _, body := range []string{"{", `{"logging":{"level":"debug"}}`} {
		rec := call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body)), h.Update)
		want := 200
		if body == "{" {
			want = 400
		}
		if rec.Code != want {
			t.Fatalf("settings update %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	nilSettings := NewSettingsHandler(nil, securityService)
	rec := call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{}`)), nilSettings.Update)
	if rec.Code != 500 {
		t.Fatalf("nil settings update: %d", rec.Code)
	}

	rec = call(httptest.NewRequest(http.MethodGet, "/", nil), h.GetSecurity)
	if rec.Code != 401 {
		t.Fatalf("security unauthenticated: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodGet, "/", "", "user"), h.GetSecurity)
	if rec.Code != 200 {
		t.Fatalf("get security: %d %s", rec.Code, rec.Body.String())
	}
	for _, body := range []string{"{", `{"notification_frequency":"never"}`, `{"notification_frequency":"instant","notifications_enabled":true}`} {
		rec = call(userRequest(http.MethodPut, "/", body, "user"), h.UpdateSecurity)
		want := 200
		if body != `{"notification_frequency":"instant","notifications_enabled":true}` {
			want = 400
		}
		if rec.Code != want {
			t.Fatalf("update security %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}

	for _, body := range []string{"{", `{}`, `{"notify":{"enabled":false}}`} {
		rec = call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body)), h.UpdateNotifications)
		want := 200
		if body == "{" || body == `{}` {
			want = 400
		}
		if rec.Code != want {
			t.Fatalf("update notifications %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	for _, body := range []string{`{}`, `{"template":"Hello {{.Name}}","data":{"Name":"Ada"}}`} {
		rec = call(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)), h.PreviewTemplate)
		want := 200
		if body == `{}` {
			want = 400
		}
		if rec.Code != want {
			t.Fatalf("preview %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}

	rec = call(httptest.NewRequest(http.MethodPost, "/", nil), h.TestNotification)
	if rec.Code != 401 {
		t.Fatalf("test notification unauthenticated: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodPost, "/", "", "user"), h.TestNotification)
	if rec.Code != 200 {
		t.Fatalf("test notification: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(userRequest(http.MethodPost, "/", "", "user"), h.TestNotification)
	if rec.Code != 429 {
		t.Fatalf("test notification rate limit: %d", rec.Code)
	}

	for _, body := range []string{
		"{",
		`{"default_domain":"invalid"}`,
		`{"ssl_email":"invalid"}`,
		`{"mode":"wrong"}`,
		`{"auto_https":"yes"}`,
		`{"mode":"noop","default_domain":"valid.example.test","ssl_email":"a@example.test","auto_https":true}`,
	} {
		rec = call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body)), h.UpdateProxy)
		want := 400
		if strings.Contains(body, `"mode":"noop"`) {
			want = 200
		}
		if rec.Code != want {
			t.Fatalf("proxy %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	for _, value := range []string{"", "-bad.test", ".bad.test", "bad space.test", "nodot", "valid.example"} {
		_ = validateDomain(value)
	}
	for _, value := range []string{"", "missing", "@example.test", "a@", "a@@example.test", "a@example", "a@example.test"} {
		_ = validateEmail(value)
	}

	h.SetModelSource(func(context.Context) ([]agent.ModelInfo, error) {
		return []agent.ModelInfo{{ID: "model-one"}}, nil
	})
	rec = call(httptest.NewRequest(http.MethodGet, "/", nil), h.GetAISupport)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "model-one") {
		t.Fatalf("AI settings models: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{}`)), h.UpdateAISupport)
	if rec.Code != 403 {
		t.Fatalf("AI update unauthenticated: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodPut, "/", "{", "admin"), h.UpdateAISupport)
	if rec.Code != 400 {
		t.Fatalf("AI update bad json: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodPut, "/", `{"enabled":true,"main_model":"model-one"}`, "admin"), h.UpdateAISupport)
	if rec.Code != 200 {
		t.Fatalf("AI update: %d %s", rec.Code, rec.Body.String())
	}

	modelServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"data":[{"id":"remote-model"}]}`)
	}))
	defer modelServer.Close()
	rec = call(userRequest(http.MethodPost, "/", fmt.Sprintf(`{"base_url":%q,"api_key":"key"}`, modelServer.URL), "admin"), h.FetchModels)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "remote-model") {
		t.Fatalf("fetch models: %d %s", rec.Code, rec.Body.String())
	}

	securityHandler := NewSecurityHandler(securityService)
	for _, target := range []string{"/events?limit=0", "/events?offset=-1", "/events?since=bad", "/events?type=bad", "/events?severity=bad"} {
		rec = call(httptest.NewRequest(http.MethodGet, target, nil), securityHandler.ListEvents)
		if rec.Code != 400 {
			t.Fatalf("security validation %s: %d", target, rec.Code)
		}
	}
	rec = call(userRequest(http.MethodGet, "/events?limit=10&type=login_success&severity=info&since=2020-01-01T00:00:00Z", "", "user"), securityHandler.ListEvents)
	if rec.Code != 200 {
		t.Fatalf("security list: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(userRequest(http.MethodGet, "/stats", "", "user"), securityHandler.GetStats)
	if rec.Code != 403 {
		t.Fatalf("security stats user: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodGet, "/stats", "", "admin"), securityHandler.GetStats)
	if rec.Code != 200 {
		t.Fatalf("security stats admin: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(httptest.NewRequest(http.MethodGet, "/health", nil), securityHandler.GetHealth)
	if rec.Code != 200 {
		t.Fatalf("security health: %d", rec.Code)
	}
	for _, remote := range []string{"not-an-ip", "127.0.0.1:1234"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = remote
		req.Header.Set("X-Forwarded-For", "198.51.100.2")
		if getClientIP(req) == "" {
			t.Fatal("client IP should not be empty")
		}
	}
}

func TestFactoryResetAuditDDNSAndACMEHelpersCoverage(t *testing.T) {
	f := newCoverageFixture(t)
	authService := auth.NewService(f.db, "coverage-reset-secret", slog.Default())
	user, err := authService.Register(context.Background(), &auth.RegisterRequest{
		Username: "reset-user",
		Password: "ResetPassword123",
		Email:    "reset@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	reset := NewFactoryResetHandler(f.db, setup.NewService(f.db), authService)
	for _, body := range []string{"{", `{}`, `{"confirm":true}`, `{"confirm":true,"password":"wrong"}`} {
		req := httptest.NewRequest(http.MethodPost, "/reset", strings.NewReader(body))
		if strings.Contains(body, `"password"`) {
			req = requestWithCoverageUser(req, user.ID, user.Username, "admin")
		}
		rec := httptest.NewRecorder()
		reset.FactoryReset(rec, req)
		if rec.Code < 400 {
			t.Fatalf("reset validation %q: %d", body, rec.Code)
		}
	}
	req := requestWithCoverageUser(
		httptest.NewRequest(http.MethodPost, "/reset", strings.NewReader(`{"confirm":true,"password":"ResetPassword123"}`)),
		user.ID, user.Username, "admin",
	)
	rec := httptest.NewRecorder()
	reset.FactoryReset(rec, req)
	if rec.Code != 200 {
		t.Fatalf("factory reset: %d %s", rec.Code, rec.Body.String())
	}

	auditHandler := NewAuditHandler(audit.NewService(f.db))
	rec = callCoverageHandler(t, http.MethodGet, "/audit?limit=bad", "", nil, auditHandler.ListLogs)
	if rec.Code != 200 {
		t.Fatalf("audit list: %d %s", rec.Code, rec.Body.String())
	}

	ddnsService := network.NewDDNSService(f.db, network.NewDNSProviderManager(f.db), nil)
	ddns := NewDDNSHandler(ddnsService)
	rec = callCoverageHandler(t, http.MethodGet, "/ddns", "", nil, ddns.GetStatus)
	if rec.Code != 200 {
		t.Fatalf("ddns status: %d", rec.Code)
	}
	for _, body := range []string{"{", `{"interval_minutes":0}`, `{"interval_minutes":61}`, `{"interval_minutes":5}`} {
		rec = callCoverageHandler(t, http.MethodPut, "/ddns", body, nil, ddns.SetInterval)
		want := 400
		if strings.Contains(body, ":5") {
			want = 200
		}
		if rec.Code != want {
			t.Fatalf("ddns interval %q: %d", body, rec.Code)
		}
	}

	acme := NewACMEHandler(f.db, nil, f.caddy, f.manager)
	acme.appBackends["mapped"] = "http://127.0.0.1:1234"
	f.manager.RegisterNamedBackend("named", "api", "http://127.0.0.1:2345")
	for _, request := range []network.ACMERequest{
		{Backend: "http://explicit"},
		{AppID: "mapped"},
		{AppID: "named", BackendName: "api"},
		{Domain: "unknown.example.test"},
	} {
		if acme.resolveBackend(request) == "" {
			t.Fatal("ACME backend should resolve")
		}
	}
	cleanup := NewACMECleanupHandler(nil)
	rec = callCoverageHandler(t, http.MethodDelete, "/routes/x", "", nil, cleanup.DeleteRoute)
	if rec.Code != 500 {
		t.Fatalf("nil ACME cleanup: %d", rec.Code)
	}
}
