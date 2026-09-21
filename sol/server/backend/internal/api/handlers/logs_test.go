package handlers

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

type fakeRuntime struct {
	containers []runtime.ContainerInfo
	inspect    *runtime.ContainerInspectResult
	logs       string
	findErr    error
	logsErr    error
}

func (f *fakeRuntime) ComposeUp(context.Context, string) error   { return nil }
func (f *fakeRuntime) ComposeDown(context.Context, string) error { return nil }
func (f *fakeRuntime) ComposePull(context.Context, string) error { return nil }
func (f *fakeRuntime) ComposeStop(context.Context, string) error { return nil }
func (f *fakeRuntime) ListContainersByLabel(context.Context, string) ([]runtime.ContainerInfo, error) {
	return nil, nil
}
func (f *fakeRuntime) ListContainersAll(context.Context) ([]runtime.ContainerInfo, error) {
	return nil, nil
}
func (f *fakeRuntime) GetContainerStats(context.Context, string) (*runtime.ContainerStats, error) {
	return nil, nil
}
func (f *fakeRuntime) InspectContainer(context.Context, string) (*runtime.ContainerInspectResult, error) {
	return f.inspect, nil
}
func (f *fakeRuntime) ContainerLogs(context.Context, string, runtime.LogOptions) (io.ReadCloser, error) {
	if f.logsErr != nil {
		return nil, f.logsErr
	}
	return io.NopCloser(strings.NewReader(f.logs)), nil
}
func (f *fakeRuntime) FindContainersByInstanceID(context.Context, string) ([]runtime.ContainerInfo, error) {
	if f.findErr != nil {
		return nil, f.findErr
	}
	return f.containers, nil
}
func (f *fakeRuntime) HealthCheck() error { return nil }
func (f *fakeRuntime) Close() error       { return nil }

func TestStreamLogsRequiresInstanceID(t *testing.T) {
	h := NewLogsHandler(&fakeRuntime{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs/stream", nil)
	h.StreamLogs(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestStreamLogsNotFound(t *testing.T) {
	h := NewLogsHandler(&fakeRuntime{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs/stream?instanceId=missing", nil)
	h.StreamLogs(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestStreamLogsTTY(t *testing.T) {
	rt := &fakeRuntime{
		containers: []runtime.ContainerInfo{{ID: "c1", Names: []string{"app"}}},
		inspect:    &runtime.ContainerInspectResult{ID: "c1", TTY: true},
		logs:       "line one\nline two\n",
	}
	h := NewLogsHandler(rt)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs/stream?instanceId=inst1&follow=false&tail=10", nil)
	h.StreamLogs(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "line one") {
		t.Fatalf("missing log content: %s", rec.Body.String())
	}
}

func TestStreamLogsErrorGettingLogs(t *testing.T) {
	rt := &fakeRuntime{
		containers: []runtime.ContainerInfo{{ID: "c1"}},
		inspect:    &runtime.ContainerInspectResult{ID: "c1", TTY: true},
		logsErr:    io.ErrUnexpectedEOF,
	}
	h := NewLogsHandler(rt)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs/stream?instanceId=inst1", nil)
	h.StreamLogs(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 SSE with error event, got %d", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("Failed to get container logs")) {
		t.Fatalf("body=%s", rec.Body.String())
	}
}
