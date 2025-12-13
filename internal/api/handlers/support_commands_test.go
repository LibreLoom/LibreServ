package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

func setupCommandSvc(t *testing.T) *support.Service {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, _ := database.Open(dbPath)
	_ = db.Migrate()
	return support.NewService(db, fakeLicenseOK{})
}

func TestSupportCommandHandlerPathDenied(t *testing.T) {
	svc := setupCommandSvc(t)
	handler := NewSupportCommandHandler(svc)
	sess, err := svc.CreateSession(context.Background(), support.CreateRequest{
		Scopes: []string{"shell-lite"},
		TTL:    time.Hour,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	// Attempt to read /etc/passwd via cat should be denied by policy
	req := commandRequest{
		Code:    sess.Code,
		Token:   sess.Token,
		Command: "cat",
		Args:    []string{"/etc/passwd"},
	}
	body, _ := json.Marshal(req)
	rr := httptest.NewRecorder()
	handler.Run(rr, httptest.NewRequest(http.MethodPost, "/command", bytes.NewBuffer(body)))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected forbid, got %d", rr.Code)
	}
}

func TestSupportCommandHandlerAllowListed(t *testing.T) {
	svc := setupCommandSvc(t)
	handler := NewSupportCommandHandler(svc)
	sess, _ := svc.CreateSession(context.Background(), support.CreateRequest{
		Scopes: []string{"shell-lite"},
		TTL:    time.Hour,
	})
	// Create a temp file under scratch
	dir := filepath.Join("/tmp", "libreserv-support")
	_ = os.MkdirAll(dir, 0o755)
	tmpFile := filepath.Join(dir, "file.txt")
	_ = os.WriteFile(tmpFile, []byte("hi"), 0o644)
	req := commandRequest{
		Code:    sess.Code,
		Token:   sess.Token,
		Command: "cat",
		Args:    []string{tmpFile},
	}
	body, _ := json.Marshal(req)
	rr := httptest.NewRecorder()
	handler.Run(rr, httptest.NewRequest(http.MethodPost, "/command", bytes.NewBuffer(body)))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestSupportCommandDockerDenied(t *testing.T) {
	svc := setupCommandSvc(t)
	handler := NewSupportCommandHandler(svc)
	sess, _ := svc.CreateSession(context.Background(), support.CreateRequest{
		Scopes: []string{"shell-full"},
		TTL:    time.Hour,
	})
	req := commandRequest{
		Code:    sess.Code,
		Token:   sess.Token,
		Command: "docker",
		Args:    []string{"run", "-v", "/:/host", "alpine"},
	}
	body, _ := json.Marshal(req)
	rr := httptest.NewRecorder()
	handler.Run(rr, httptest.NewRequest(http.MethodPost, "/command", bytes.NewBuffer(body)))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for docker run, got %d", rr.Code)
	}
}
