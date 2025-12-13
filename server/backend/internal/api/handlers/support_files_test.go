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

type fakeLicenseOK struct{}

func (fakeLicenseOK) Valid() bool          { return true }
func (fakeLicenseOK) SupportLevel() string { return "priority" }
func (fakeLicenseOK) LicenseID() string    { return "lic-1" }
func (fakeLicenseOK) Reason() string       { return "" }

func setupSupportSvc(t *testing.T) *support.Service {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, _ := database.Open(dbPath)
	_ = db.Migrate()
	return support.NewService(db, fakeLicenseOK{})
}

func TestSupportFileReadWriteScopes(t *testing.T) {
	svc := setupSupportSvc(t)
	handler := NewSupportFileHandler(svc)
	// create session with files scopes
	sess, err := svc.CreateSession(context.Background(), support.CreateRequest{
		Scopes: []string{"files-ro", "files-rw"},
		TTL:    time.Hour,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	allowedDir := filepath.Join("/tmp", "libreserv-support")
	_ = os.MkdirAll(allowedDir, 0o755)
	writeReq := fileRequest{Code: sess.Code, Token: sess.Token, Path: filepath.Join(allowedDir, "file.txt"), Data: "hello"}
	body, _ := json.Marshal(writeReq)
	wrec := httptest.NewRecorder()
	handler.Write(wrec, httptest.NewRequest(http.MethodPost, "/write", bytes.NewBuffer(body)))
	if wrec.Code != http.StatusOK {
		t.Fatalf("write status %d", wrec.Code)
	}

	// Read
	rrec := httptest.NewRecorder()
	readReq := fileRequest{Code: sess.Code, Token: sess.Token, Path: writeReq.Path}
	body2, _ := json.Marshal(readReq)
	handler.Read(rrec, httptest.NewRequest(http.MethodPost, "/read", bytes.NewBuffer(body2)))
	if rrec.Code != http.StatusOK {
		t.Fatalf("read status %d", rrec.Code)
	}
}
