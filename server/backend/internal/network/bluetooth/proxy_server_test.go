//go:build libreserv_ble

package bluetooth

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestDispatchHTTP_MockRouter(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/api/v1/test", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	SetRouter(r)

	s := newProxyServer("test", nil)
	chunks, err := s.dispatchHTTP("GET", "/api/v1/test", nil, nil)
	if err != nil {
		t.Fatalf("dispatchHTTP error: %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least one chunk")
	}
	first := chunks[0]
	if first.Status != 200 {
		t.Fatalf("expected status 200, got %d", first.Status)
	}
	if first.Headers["Content-Type"] != "application/json" {
		t.Fatalf("expected Content-Type header, got %+v", first.Headers)
	}
	if !first.Final {
		t.Fatal("expected single chunk to be final")
	}

	body, _ := base64.StdEncoding.DecodeString(first.Body)
	if string(body) != `{"status":"ok"}` {
		t.Fatalf("unexpected body: %s", string(body))
	}
}

func TestDispatchHTTP_MultiChunk(t *testing.T) {
	// Return a large payload that will be split into multiple chunks
	largePayload := bytes.Repeat([]byte("x"), 1000)

	r := chi.NewRouter()
	r.Get("/large", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write(largePayload)
	})
	SetRouter(r)

	s := newProxyServer("test", nil)
	chunks, err := s.dispatchHTTP("GET", "/large", nil, nil)
	if err != nil {
		t.Fatalf("dispatchHTTP error: %v", err)
	}
	if len(chunks) < 2 {
		t.Fatalf("expected multiple chunks, got %d", len(chunks))
	}
	if chunks[0].Status != 200 {
		t.Fatalf("expected status 200 on first chunk, got %d", chunks[0].Status)
	}
	if chunks[1].Status != 0 {
		t.Fatalf("expected status 0 on second chunk, got %d", chunks[1].Status)
	}
	if !chunks[len(chunks)-1].Final {
		t.Fatal("expected last chunk to be final")
	}

	var assembled []byte
	for _, c := range chunks {
		part, _ := base64.StdEncoding.DecodeString(c.Body)
		assembled = append(assembled, part...)
	}
	if !bytes.Equal(assembled, largePayload) {
		t.Fatalf("assembled body mismatch: expected %d bytes, got %d", len(largePayload), len(assembled))
	}
}

func TestDispatchHTTP_RouterNotReady(t *testing.T) {
	SetRouter(nil)
	s := newProxyServer("test", nil)
	_, err := s.dispatchHTTP("GET", "/", nil, nil)
	if err == nil {
		t.Fatal("expected error when router is nil")
	}
	if !strings.Contains(err.Error(), "router not ready") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestHandleAuthWrite_CaseInsensitive(t *testing.T) {
	s := newProxyServer("A1B2C3", nil)
	s.authed = false

	// Write lowercase code
	s.handleAuthWrite(0, 0, []byte("a1b2c3"))

	if !s.authed {
		t.Fatal("expected auth to succeed with case-insensitive match")
	}
}

func TestPendingReqTimeoutLogic(t *testing.T) {
	s := newProxyServer("test", nil)
	s.pendingReqs["test-id"] = &pendingReq{
		method:  "GET",
		path:    "/",
		headers: nil,
		bodyBuf: bytes.NewBuffer(nil),
		started: time.Now().Add(-70 * time.Second),
	}

	// Simulate the timeout logic directly (same as pendingReqTimeoutLoop inner loop)
	s.mu.Lock()
	now := time.Now()
	var timedOut []string
	for id, p := range s.pendingReqs {
		if now.Sub(p.started) > 60*time.Second {
			timedOut = append(timedOut, id)
		}
	}
	for _, id := range timedOut {
		delete(s.pendingReqs, id)
	}
	s.mu.Unlock()

	if _, ok := s.pendingReqs["test-id"]; ok {
		t.Fatal("expected timed-out request to be removed")
	}
}
