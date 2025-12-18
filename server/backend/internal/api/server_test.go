package api

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestServeSPAFallsBackToIndex(t *testing.T) {
	dir := t.TempDir()
	indexPath := filepath.Join(dir, "index.html")
	if err := os.WriteFile(indexPath, []byte("index file"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}

	s := &Server{
		router:    chi.NewRouter(),
		logger:    slog.Default(),
		staticDir: dir,
	}

	req := httptest.NewRequest(http.MethodGet, "/missing/route", nil)
	rr := httptest.NewRecorder()

	s.serveSPA(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
	if rr.Body.String() != "index file" {
		t.Fatalf("expected index.html content, got %q", rr.Body.String())
	}
}

func TestServeSPAServesExistingFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatalf("mkdir assets: %v", err)
	}
	indexPath := filepath.Join(dir, "index.html")
	assetPath := filepath.Join(dir, "assets", "file.txt")
	if err := os.WriteFile(indexPath, []byte("index file"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	if err := os.WriteFile(assetPath, []byte("asset file"), 0o644); err != nil {
		t.Fatalf("write asset: %v", err)
	}

	s := &Server{
		router:    chi.NewRouter(),
		logger:    slog.Default(),
		staticDir: dir,
	}

	req := httptest.NewRequest(http.MethodGet, "/assets/file.txt", nil)
	rr := httptest.NewRecorder()

	s.serveSPA(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
	if rr.Body.String() != "asset file" {
		t.Fatalf("expected asset content, got %q", rr.Body.String())
	}
}
