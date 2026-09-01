package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

func newBackupHandlerTest(t *testing.T) (*BackupHandlers, *storage.BackupService, *database.DB, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "handlers.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := db.Migrate(); err != nil {
		_ = db.Close()
		t.Fatalf("migrate database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	service := storage.NewBackupService(db, &podman.Client{}, filepath.Join(dir, "backups"), filepath.Join(dir, "apps"))
	service.SetServerSecret("server-secret")
	service.SetEncryptionKey("encryption-key")
	return NewBackupHandlers(service), service, db, dir
}

func callBackupHandler(t *testing.T, call func(http.ResponseWriter, *http.Request), req *http.Request, want int) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	call(rec, req)
	if rec.Code != want {
		t.Fatalf("status = %d, want %d, body %s", rec.Code, want, rec.Body)
	}
	return rec
}

func TestBackupHandlersListGetDeleteAndValidation(t *testing.T) {
	handler, _, db, dir := newBackupHandlerTest(t)
	now := time.Now()
	appPath := filepath.Join(dir, "apps", "app-1")
	if _, err := db.Exec(
		`INSERT INTO apps (id, name, type, path, status) VALUES ('app-1', 'App', 'repo', ?, 'stopped')`,
		appPath,
	); err != nil {
		t.Fatalf("insert app: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO backups (id, app_id, type, path, size, created_at, checksum, source, format, snapshot_id, repo_id)
		VALUES ('backup-1', 'app-1', 'app', '/tmp/repo', 10, ?, 'sum', 'local', 'restic', '', '')`,
		now,
	); err != nil {
		t.Fatalf("insert backup: %v", err)
	}

	rec := callBackupHandler(t, handler.ListBackups, httptest.NewRequest(http.MethodGet, "/backups?app_id=app-1", nil), http.StatusOK)
	if !strings.Contains(rec.Body.String(), `"count":1`) || !strings.Contains(rec.Body.String(), `"id":"backup-1"`) {
		t.Fatalf("list body = %s", rec.Body)
	}
	callBackupHandler(t, handler.GetBackup, httptest.NewRequest(http.MethodGet, "/backups/", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.GetBackup, requestWithJobParam(http.MethodGet, "/backups/missing", "backupID", "missing"), http.StatusNotFound)
	rec = callBackupHandler(t, handler.GetBackup, requestWithJobParam(http.MethodGet, "/backups/backup-1", "backupID", "backup-1"), http.StatusOK)
	if !strings.Contains(rec.Body.String(), `"checksum":"sum"`) {
		t.Fatalf("get body = %s", rec.Body)
	}

	callBackupHandler(t, handler.CreateBackup, httptest.NewRequest(http.MethodPost, "/backups", strings.NewReader(`{`)), http.StatusBadRequest)
	callBackupHandler(t, handler.CreateBackup, httptest.NewRequest(http.MethodPost, "/backups", strings.NewReader(`{}`)), http.StatusBadRequest)
	callBackupHandler(t, handler.CreateBackup, httptest.NewRequest(http.MethodPost, "/backups", strings.NewReader(`{"app_id":"missing"}`)), http.StatusInternalServerError)
	callBackupHandler(t, handler.RestoreBackup, httptest.NewRequest(http.MethodPost, "/backups//restore", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.RestoreBackup, requestWithJobParam(http.MethodPost, "/backups/missing/restore", "backupID", "missing"), http.StatusInternalServerError)
	callBackupHandler(t, handler.DeleteBackup, httptest.NewRequest(http.MethodDelete, "/backups/", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.DeleteBackup, requestWithJobParam(http.MethodDelete, "/backups/missing", "backupID", "missing"), http.StatusInternalServerError)
	callBackupHandler(t, handler.DownloadBackup, httptest.NewRequest(http.MethodGet, "/backups//download", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.DownloadBackup, requestWithJobParam(http.MethodGet, "/backups/missing/download", "backupID", "missing"), http.StatusInternalServerError)

	callBackupHandler(t, handler.DeleteBackup, requestWithJobParam(http.MethodDelete, "/backups/backup-1", "backupID", "backup-1"), http.StatusOK)
}

func TestBackupHandlersDatabaseBackupAndUpload(t *testing.T) {
	handler, _, db, _ := newBackupHandlerTest(t)
	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'hash')`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	rec := callBackupHandler(t, handler.CreateDatabaseBackup, httptest.NewRequest(http.MethodPost, "/database-backups", nil), http.StatusOK)
	if rec.Header().Get("Content-Type") != "application/octet-stream" || rec.Body.Len() == 0 {
		t.Fatalf("database backup response headers=%v size=%d", rec.Header(), rec.Body.Len())
	}

	rec = callBackupHandler(t, handler.ListDatabaseBackups, httptest.NewRequest(http.MethodGet, "/database-backups", nil), http.StatusOK)
	if !strings.Contains(rec.Body.String(), `"count":0`) {
		t.Fatalf("database list = %s", rec.Body)
	}
	callBackupHandler(t, handler.RestoreDatabaseBackup, httptest.NewRequest(http.MethodPost, "/database-backups//restore", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.RestoreDatabaseBackup,
		requestWithJobParam(http.MethodPost, "/database-backups/missing/restore", "backupID", "missing"),
		http.StatusInternalServerError,
	)
	badJSON := requestWithJobParam(http.MethodPost, "/database-backups/x/restore", "backupID", "x")
	badJSON.Body = io.NopCloser(strings.NewReader(`{`))
	callBackupHandler(t, handler.RestoreDatabaseBackup, badJSON, http.StatusBadRequest)

	callBackupHandler(t, handler.UploadDatabaseBackup, httptest.NewRequest(http.MethodPost, "/database-backups/upload", strings.NewReader("not multipart")), http.StatusBadRequest)
	var missing bytes.Buffer
	missingWriter := multipart.NewWriter(&missing)
	_ = missingWriter.Close()
	missingReq := httptest.NewRequest(http.MethodPost, "/database-backups/upload", &missing)
	missingReq.Header.Set("Content-Type", missingWriter.FormDataContentType())
	callBackupHandler(t, handler.UploadDatabaseBackup, missingReq, http.StatusBadRequest)

	var unsupported bytes.Buffer
	unsupportedWriter := multipart.NewWriter(&unsupported)
	part, _ := unsupportedWriter.CreateFormFile("backup", "backup.txt")
	_, _ = part.Write([]byte("data"))
	_ = unsupportedWriter.Close()
	unsupportedReq := httptest.NewRequest(http.MethodPost, "/database-backups/upload", &unsupported)
	unsupportedReq.Header.Set("Content-Type", unsupportedWriter.FormDataContentType())
	callBackupHandler(t, handler.UploadDatabaseBackup, unsupportedReq, http.StatusBadRequest)

	var invalidBackup bytes.Buffer
	invalidWriter := multipart.NewWriter(&invalidBackup)
	part, _ = invalidWriter.CreateFormFile("backup", "../uploaded.db.gz")
	_, _ = part.Write([]byte("not gzip"))
	_ = invalidWriter.Close()
	invalidReq := httptest.NewRequest(http.MethodPost, "/database-backups/upload", &invalidBackup)
	invalidReq.Header.Set("Content-Type", invalidWriter.FormDataContentType())
	callBackupHandler(t, handler.UploadDatabaseBackup, invalidReq, http.StatusInternalServerError)
}

func TestBackupScheduleHandlers(t *testing.T) {
	handler, _, db, dir := newBackupHandlerTest(t)
	if _, err := db.Exec(
		`INSERT INTO apps (id, name, type, path, status) VALUES ('scheduled', 'Scheduled', 'repo', ?, 'stopped')`,
		filepath.Join(dir, "scheduled"),
	); err != nil {
		t.Fatalf("insert app: %v", err)
	}

	callBackupHandler(t, handler.CreateSchedule, httptest.NewRequest(http.MethodPost, "/schedules", strings.NewReader(`{`)), http.StatusBadRequest)
	callBackupHandler(t, handler.CreateSchedule, httptest.NewRequest(http.MethodPost, "/schedules", strings.NewReader(`{}`)), http.StatusBadRequest)
	rec := callBackupHandler(t, handler.CreateSchedule, httptest.NewRequest(http.MethodPost, "/schedules", strings.NewReader(
		`{"app_id":"scheduled","cron_expr":"0 2 * * *","enabled":true}`,
	)), http.StatusCreated)
	var created storage.BackupSchedule
	if err := json.NewDecoder(strings.NewReader(rec.Body.String())).Decode(&created); err != nil || created.ID == "" ||
		created.Type != storage.BackupTypeApp || created.Retention != 7 {
		t.Fatalf("created schedule = %+v, %v; body %s", created, err, rec.Body)
	}

	rec = callBackupHandler(t, handler.ListSchedules, httptest.NewRequest(http.MethodGet, "/schedules", nil), http.StatusOK)
	if !strings.Contains(rec.Body.String(), `"count":1`) {
		t.Fatalf("schedule list = %s", rec.Body)
	}
	callBackupHandler(t, handler.GetSchedule, httptest.NewRequest(http.MethodGet, "/schedules/", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.GetSchedule, requestWithJobParam(http.MethodGet, "/schedules/missing", "scheduleID", "missing"), http.StatusNotFound)
	callBackupHandler(t, handler.GetSchedule, requestWithJobParam(http.MethodGet, "/schedules/"+created.ID, "scheduleID", created.ID), http.StatusOK)

	callBackupHandler(t, handler.UpdateSchedule, httptest.NewRequest(http.MethodPut, "/schedules/", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.UpdateSchedule,
		requestWithBodyAndParam(http.MethodPut, "/schedules/x", "{", "scheduleID", "x"),
		http.StatusBadRequest,
	)
	callBackupHandler(t, handler.UpdateSchedule,
		requestWithBodyAndParam(http.MethodPut, "/schedules/missing", `{}`, "scheduleID", "missing"),
		http.StatusNotFound,
	)
	rec = callBackupHandler(t, handler.UpdateSchedule,
		requestWithBodyAndParam(http.MethodPut, "/schedules/"+created.ID,
			`{"cron_expr":"30 3 * * *","enabled":false,"stop_before_backup":true,"retention":2}`,
			"scheduleID", created.ID),
		http.StatusOK,
	)
	if !strings.Contains(rec.Body.String(), `"retention":2`) || !strings.Contains(rec.Body.String(), `"stop_before_backup":true`) {
		t.Fatalf("updated schedule = %s", rec.Body)
	}
	callBackupHandler(t, handler.DeleteSchedule, httptest.NewRequest(http.MethodDelete, "/schedules/", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.DeleteSchedule,
		requestWithJobParam(http.MethodDelete, "/schedules/"+created.ID, "scheduleID", created.ID),
		http.StatusOK,
	)
}

func requestWithBodyAndParam(method, target, body, key, value string) *http.Request {
	req := requestWithJobParam(method, target, key, value)
	req.Body = io.NopCloser(strings.NewReader(body))
	return req
}

func TestBackupRepositoryHandlers(t *testing.T) {
	handler, service, _, dir := newBackupHandlerTest(t)
	ctx := context.Background()
	now := time.Now()
	repo := &storage.BackupRepository{
		ID: "repo-1", RepoType: "local", RepoPath: filepath.Join(dir, "repo"),
		Password: "recovery-secret", CreatedAt: now, UpdatedAt: now,
	}
	if err := service.CreateRepository(ctx, repo); err != nil {
		t.Fatalf("create repository: %v", err)
	}

	rec := callBackupHandler(t, handler.ListRepositories, httptest.NewRequest(http.MethodGet, "/repositories", nil), http.StatusOK)
	if !strings.Contains(rec.Body.String(), `"count":1`) || strings.Contains(rec.Body.String(), "recovery-secret") ||
		strings.Contains(rec.Body.String(), `"password"`) {
		t.Fatalf("safe repositories response = %s", rec.Body)
	}
	callBackupHandler(t, handler.CreateRepository, httptest.NewRequest(http.MethodPost, "/repositories", strings.NewReader(`{`)), http.StatusBadRequest)
	callBackupHandler(t, handler.CreateRepository, httptest.NewRequest(http.MethodPost, "/repositories", strings.NewReader(`{}`)), http.StatusBadRequest)
	callBackupHandler(t, handler.CreateRepository, httptest.NewRequest(http.MethodPost, "/repositories", strings.NewReader(`{"repo_type":"local"}`)), http.StatusBadRequest)
	callBackupHandler(t, handler.CreateRepository, httptest.NewRequest(http.MethodPost, "/repositories", strings.NewReader(
		`{"repo_type":"local","repo_path":"/tmp/new","credentials":{"token":"secret"}}`,
	)), http.StatusPreconditionFailed)

	callBackupHandler(t, handler.TestRepository, httptest.NewRequest(http.MethodPost, "/repositories/test", strings.NewReader(`{`)), http.StatusBadRequest)
	callBackupHandler(t, handler.TestRepository, httptest.NewRequest(http.MethodPost, "/repositories/test", strings.NewReader(`{}`)), http.StatusPreconditionFailed)
	rec = callBackupHandler(t, handler.GetBackupCapabilities, httptest.NewRequest(http.MethodGet, "/capabilities", nil), http.StatusOK)
	if !strings.Contains(rec.Body.String(), `"restic_available":false`) {
		t.Fatalf("capabilities = %s", rec.Body)
	}
	callBackupHandler(t, handler.GetRepoStats, httptest.NewRequest(http.MethodGet, "/repositories//stats", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.GetRepoStats,
		requestWithJobParam(http.MethodGet, "/repositories/repo-1/stats", "repoID", "repo-1"),
		http.StatusInternalServerError,
	)
	callBackupHandler(t, handler.GetRepositoryRecoveryKey, httptest.NewRequest(http.MethodGet, "/repositories//key", nil), http.StatusBadRequest)
	rec = callBackupHandler(t, handler.GetRepositoryRecoveryKey,
		requestWithJobParam(http.MethodGet, "/repositories/repo-1/key", "repoID", "repo-1"),
		http.StatusOK,
	)
	if !strings.Contains(rec.Body.String(), `"recovery_key":"recovery-secret"`) {
		t.Fatalf("recovery response = %s", rec.Body)
	}
	callBackupHandler(t, handler.GetRepositoryRecoveryKey,
		requestWithJobParam(http.MethodGet, "/repositories/missing/key", "repoID", "missing"),
		http.StatusInternalServerError,
	)
	callBackupHandler(t, handler.DeleteRepository, httptest.NewRequest(http.MethodDelete, "/repositories/", nil), http.StatusBadRequest)
	callBackupHandler(t, handler.DeleteRepository,
		requestWithJobParam(http.MethodDelete, "/repositories/repo-1", "repoID", "repo-1"),
		http.StatusOK,
	)
}
