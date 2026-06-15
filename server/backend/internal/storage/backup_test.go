package storage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage/restic"
)

func hasResticBinary(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("restic"); err != nil {
		t.Skip("restic binary not available, skipping integration test")
	}
}

func setupTestService(t *testing.T) (*BackupService, string) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	backupSvc := NewBackupService(db, &podman.Client{}, dir, filepath.Join(dir, "apps"))
	backupSvc.SetServerSecret("test-secret-key-for-testing")
	backupSvc.SetEncryptionKey("test-encryption-key-for-testing")
	return backupSvc, dir
}

func TestBackupOptionsDefaults(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, _ := database.Open(dbPath)
	_ = db.Migrate()
	backupSvc := NewBackupService(db, &podman.Client{}, dir, filepath.Join(dir, "apps"))
	backupSvc.SetServerSecret("test-secret")
	backupSvc.SetEncryptionKey("test-encryption-key")

	_, err := backupSvc.BackupDatabase(context.Background())
	if err == nil {
		return
	}
}

func TestBackupService_ResticDetection(t *testing.T) {
	svc, _ := setupTestService(t)
	_ = svc.UseRestic()
}

func TestBackupService_SetServerSecret(t *testing.T) {
	svc, _ := setupTestService(t)
	svc.SetServerSecret("new-secret")
}

func TestBackupRepositoryCRUD(t *testing.T) {
	svc, _ := setupTestService(t)
	ctx := context.Background()

	svc.db.Exec(`INSERT INTO apps (id, name, type, path, status) VALUES (?, ?, ?, ?, ?)`,
		"app-1", "TestApp", "builtin", "/tmp/app-1", "stopped")

	repo := &BackupRepository{
		ID:        "test-repo-1",
		AppID:     "app-1",
		RepoType:  "local",
		RepoPath:  "/tmp/test-repo",
		Password:  restic.DeriveRepoPassword("secret", "app-1"),
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := svc.CreateRepository(ctx, repo); err != nil {
		t.Fatalf("CreateRepository: %v", err)
	}

	got, err := svc.GetRepository(ctx, "test-repo-1")
	if err != nil {
		t.Fatalf("GetRepository: %v", err)
	}
	if got.RepoType != "local" {
		t.Errorf("expected local, got %s", got.RepoType)
	}

	repos, err := svc.ListRepositories(ctx)
	if err != nil {
		t.Fatalf("ListRepositories: %v", err)
	}
	if len(repos) != 1 {
		t.Fatalf("expected 1 repo, got %d", len(repos))
	}

	appRepo, err := svc.GetRepositoryForApp(ctx, "app-1")
	if err != nil {
		t.Fatalf("GetRepositoryForApp: %v", err)
	}
	if appRepo.ID != "test-repo-1" {
		t.Errorf("expected test-repo-1, got %s", appRepo.ID)
	}

	if err := svc.DeleteRepository(ctx, "test-repo-1"); err != nil {
		t.Fatalf("DeleteRepository: %v", err)
	}

	_, err = svc.GetRepository(ctx, "test-repo-1")
	if err == nil {
		t.Fatal("expected error after delete")
	}
}

func TestBackupRepositoryValidation(t *testing.T) {
	svc, _ := setupTestService(t)
	ctx := context.Background()

	repo := &BackupRepository{
		ID:        "bad-repo",
		RepoType:  "ftp",
		RepoPath:  "/tmp/bad",
		Password:  "test",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := svc.CreateRepository(ctx, repo); err == nil {
		t.Fatal("expected error for invalid repo type")
	}
}

func TestBackupFormatField(t *testing.T) {
	svc, _ := setupTestService(t)
	ctx := context.Background()

	db := svc.db
	now := time.Now()

	db.Exec(`INSERT INTO apps (id, name, type, path, status) VALUES (?, ?, ?, ?, ?)`,
		"app-fmt", "TestApp", "builtin", "/tmp/app-fmt", "stopped")

	db.Exec(`INSERT INTO backups (id, app_id, type, path, size, created_at, format, snapshot_id, repo_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"b-restic", "app-fmt", "app", "/tmp/repo", 1000, now, "restic", "snap-1", "repo-1")

	db.Exec(`INSERT INTO backups (id, app_id, type, path, size, created_at, format, snapshot_id, repo_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"b-restic-2", "app-fmt", "app", "/tmp/repo2", 2000, now, "restic", "snap-2", "repo-2")

	backups, err := svc.ListBackups(ctx, "app-fmt")
	if err != nil {
		t.Fatalf("ListBackups: %v", err)
	}
	if len(backups) != 2 {
		t.Fatalf("expected 2 backups, got %d", len(backups))
	}

	for _, b := range backups {
		if b.Format != BackupFormatRestic {
			t.Errorf("expected restic format, got %s", b.Format)
		}
	}
}

func TestGetBackupWithFormat(t *testing.T) {
	svc, _ := setupTestService(t)
	ctx := context.Background()

	db := svc.db
	now := time.Now()

	db.Exec(`INSERT INTO apps (id, name, type, path, status) VALUES (?, ?, ?, ?, ?)`,
		"app-get", "TestApp", "builtin", "/tmp/app-get", "stopped")

	db.Exec(`INSERT INTO backups (id, app_id, type, path, size, created_at, format, snapshot_id, repo_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"b-get-restic", "app-get", "app", "/tmp/repo", 1000, now, "restic", "snap-get", "repo-get")

	backup, err := svc.GetBackup(ctx, "b-get-restic")
	if err != nil {
		t.Fatalf("GetBackup: %v", err)
	}
	if backup.Format != BackupFormatRestic {
		t.Errorf("expected restic, got %s", backup.Format)
	}
	if backup.SnapshotID != "snap-get" {
		t.Errorf("expected snap-get, got %s", backup.SnapshotID)
	}
}

func TestBackupScheduleUpdateNextRun(t *testing.T) {
	svc, _ := setupTestService(t)
	ctx := context.Background()

	db := svc.db
	now := time.Now()
	nextRun := now.Add(24 * time.Hour)

	db.Exec(`INSERT INTO apps (id, name, type, path, status) VALUES (?, ?, ?, ?, ?)`,
		"app-sch", "TestApp", "builtin", "/tmp/app-sch", "stopped")

	db.Exec(`INSERT INTO backup_schedules (id, app_id, type, cron_expr, enabled, retention, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		"sch-1", "app-sch", "app", "0 3 * * *", 1, 7, now, now)

	if err := svc.UpdateScheduleNextRun(ctx, "sch-1", now, nextRun); err != nil {
		t.Fatalf("UpdateScheduleNextRun: %v", err)
	}

	schedule, err := svc.GetSchedule(ctx, "sch-1")
	if err != nil {
		t.Fatalf("GetSchedule: %v", err)
	}
	if schedule.LastRun == nil {
		t.Fatal("expected last_run to be set")
	}
	if schedule.NextRun == nil {
		t.Fatal("expected next_run to be set")
	}
}

func TestDeleteResticBackup(t *testing.T) {
	svc, _ := setupTestService(t)
	ctx := context.Background()

	db := svc.db
	now := time.Now()

	db.Exec(`INSERT INTO apps (id, name, type, path, status) VALUES (?, ?, ?, ?, ?)`,
		"app-del", "TestApp", "builtin", "/tmp/app-del", "stopped")

	db.Exec(`INSERT INTO backups (id, app_id, type, path, size, created_at, format, snapshot_id, repo_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"b-del-restic", "app-del", "app", "/tmp/repo", 1000, now, "restic", "snap-del", "repo-del")

	if err := svc.DeleteBackup(ctx, "b-del-restic"); err != nil {
		t.Fatalf("DeleteBackup: %v", err)
	}

	_, err := svc.GetBackup(ctx, "b-del-restic")
	if err == nil {
		t.Fatal("expected error after delete")
	}
}

func TestResticBackupAndRestore(t *testing.T) {
	hasResticBinary(t)

	svc, dir := setupTestService(t)
	ctx := context.Background()

	db := svc.db

	appPath := filepath.Join(dir, "apps", "test-app")
	if err := os.MkdirAll(appPath, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appPath, "data.txt"), []byte("test data for restic"), 0644); err != nil {
		t.Fatal(err)
	}

	db.Exec(`INSERT INTO apps (id, name, type, path, status) VALUES (?, ?, ?, ?, ?)`,
		"test-app", "TestApp", "builtin", appPath, "stopped")

	result, err := svc.BackupApp(ctx, "test-app", BackupOptions{})
	if err != nil {
		t.Fatalf("BackupApp: %v", err)
	}
	if result.Backup == nil {
		t.Fatal("expected backup result")
	}
	if result.Backup.Format != BackupFormatRestic {
		t.Errorf("expected restic format, got %s", result.Backup.Format)
	}
	if result.Backup.SnapshotID == "" {
		t.Fatal("expected snapshot ID")
	}

	backups, err := svc.ListBackups(ctx, "test-app")
	if err != nil {
		t.Fatalf("ListBackups: %v", err)
	}
	if len(backups) == 0 {
		t.Fatal("expected at least one backup")
	}

	if err := os.Remove(filepath.Join(appPath, "data.txt")); err != nil {
		t.Fatal(err)
	}

	restoreResult, err := svc.RestoreApp(ctx, result.Backup.ID, "", RestoreOptions{
		RestartAfterRestore: false,
	})
	if err != nil {
		t.Fatalf("RestoreApp: %v", err)
	}
	if restoreResult.Error != nil {
		t.Fatalf("RestoreApp error: %v", restoreResult.Error)
	}

	data, err := os.ReadFile(filepath.Join(appPath, "data.txt"))
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if string(data) != "test data for restic" {
		t.Errorf("restored content mismatch: got %q", string(data))
	}
}

func TestCleanupOldBackups(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, _ := database.Open(dbPath)
	_ = db.Migrate()
	backupSvc := NewBackupService(db, &podman.Client{}, dir, filepath.Join(dir, "apps"))
	backupSvc.SetServerSecret("test-secret")
	backupSvc.SetEncryptionKey("test-encryption-key")
	db.Exec(`INSERT INTO backups (id, type, path, size, created_at) VALUES (?, ?, ?, ?, ?)`, "b1", "system", "/tmp/b1", 0, time.Now())
	backups, err := backupSvc.ListBackups(context.Background(), "")
	if err != nil {
		t.Fatalf("list backups: %v", err)
	}
	_ = backups
}
