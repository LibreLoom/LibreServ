// Package testutil provides shared fixtures and request helpers for the
// domain handler test packages under internal/api/handlers.
package testutil

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	containerruntime "gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

// Runtime is a stub container runtime for tests.
type Runtime struct {
	Containers []containerruntime.ContainerInfo
	UpErr      error
	StopErr    error
}

func (r *Runtime) ComposeUp(context.Context, string) error   { return r.UpErr }
func (r *Runtime) ComposeDown(context.Context, string) error { return nil }
func (r *Runtime) ComposePull(context.Context, string) error { return nil }
func (r *Runtime) ComposeStop(context.Context, string) error { return r.StopErr }
func (r *Runtime) ListContainersByLabel(context.Context, string) ([]containerruntime.ContainerInfo, error) {
	return r.Containers, nil
}
func (r *Runtime) ListContainersAll(context.Context) ([]containerruntime.ContainerInfo, error) {
	return r.Containers, nil
}
func (r *Runtime) GetContainerStats(context.Context, string) (*containerruntime.ContainerStats, error) {
	return &containerruntime.ContainerStats{}, nil
}
func (r *Runtime) InspectContainer(context.Context, string) (*containerruntime.ContainerInspectResult, error) {
	return &containerruntime.ContainerInspectResult{}, nil
}
func (r *Runtime) ContainerLogs(context.Context, string, containerruntime.LogOptions) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (r *Runtime) FindContainersByInstanceID(context.Context, string) ([]containerruntime.ContainerInfo, error) {
	return r.Containers, nil
}
func (r *Runtime) HealthCheck() error { return nil }
func (r *Runtime) Close() error       { return nil }

// Fixture wires a temporary catalog, database, Caddy manager, and app manager
// for handler tests.
type Fixture struct {
	DB      *database.DB
	Manager *apps.Manager
	Caddy   *network.CaddyManager
	Runtime *Runtime
}

func NewFixture(t *testing.T) *Fixture {
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
	rt := &Runtime{Containers: []containerruntime.ContainerInfo{{
		ID: "container-1", Names: []string{"/demo"}, State: "running", Status: "Up",
	}}}
	manager, err := apps.NewManager(catalogRoot, cfg.Apps.DataPath, rt, db, nil, nil, caddy)
	if err != nil {
		t.Fatal(err)
	}
	return &Fixture{DB: db, Manager: manager, Caddy: caddy, Runtime: rt}
}

// SeedApp registers an installed app row and backend for the given id.
func SeedApp(t *testing.T, f *Fixture, id string) {
	t.Helper()
	path := filepath.Join(config.Get().Apps.DataPath, id)
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "docker-compose.yml"), []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := f.DB.Exec(`
		INSERT INTO apps
			(id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version)
		VALUES (?, 'Demo instance', 'repo', 'demo', ?, 'running', 'healthy',
		        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, '1.0.0')`,
		id, path, `{"required_value":"visible","version":"1.0.0","route_id":"route-one"}`)
	if err != nil {
		t.Fatal(err)
	}
	f.Manager.RegisterBackend(id, "http://127.0.0.1:19091")
}

// CallHandler invokes fn with a recorder and a request carrying chi URL params.
func CallHandler(t *testing.T, method, target, body string, params map[string]string, fn http.HandlerFunc) *httptest.ResponseRecorder {
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

// RequestWithUser attaches an authenticated user to the request context.
func RequestWithUser(req *http.Request, id, username, role string) *http.Request {
	user := &middleware.User{ID: id, Username: username, Role: role}
	ctx := context.WithValue(req.Context(), middleware.UserContextKey, user)
	ctx = context.WithValue(ctx, middleware.UserIDContextKey, id)
	return req.WithContext(ctx)
}

// JSONDecode decodes a JSON response body for assertions.
func JSONDecode(data []byte, dest any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	return decoder.Decode(dest)
}

// JobQueue is a stub job queue for tests.
type JobQueue struct {
	Job *jobqueue.Job
	Err error
}

func (q *JobQueue) Enqueue(jobqueue.JobType, string, string, string, jobqueue.JobPriority) (jobqueue.JobInfo, error) {
	if q.Err != nil {
		return nil, q.Err
	}
	return q.Job, nil
}
func (q *JobQueue) GetJob(context.Context, string) (jobqueue.JobInfo, error) {
	return q.Job, q.Err
}
func (q *JobQueue) GetLatestJob(context.Context, string, jobqueue.JobType) (jobqueue.JobInfo, error) {
	return q.Job, q.Err
}
