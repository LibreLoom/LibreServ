package api

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/Sol/internal/network"
)

func TestShutdownReportsUnverifiedTailscaleStop(t *testing.T) {
	dir := t.TempDir()
	node := filepath.Join(dir, "tailscale")
	if err := os.Mkdir(node, 0700); err != nil {
		t.Fatal(err)
	}
	foreign, err := net.Listen("unix", filepath.Join(node, "tailscaled.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer foreign.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	s := &Server{router: router, logger: slog.Default(), tailscaleService: network.NewTailscaleService(dir, listener.Addr().(*net.TCPAddr).Port)}
	s.httpServer = &http.Server{Handler: s.shutdownAwareHandler()}
	go func() { _ = s.httpServer.Serve(listener) }()
	done := make(chan error, 1)
	go func() { done <- s.Shutdown(context.Background()) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("unverified stop returned success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not return")
	}
	if _, err := os.Stat(filepath.Join(node, "stop-failed")); err != nil {
		t.Fatalf("missing residual marker: %v", err)
	}
}
