package storage

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage/restic"
)

func newStorageService(t *testing.T) (*BackupService, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "storage.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := db.Migrate(); err != nil {
		_ = db.Close()
		t.Fatalf("migrate database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return &BackupService{
		db:            db,
		basePath:      filepath.Join(dir, "backups"),
		appDataPath:   filepath.Join(dir, "apps"),
		serverSecret:  "server-secret",
		encryptionKey: "encryption-key",
	}, dir
}

func insertStorageApp(t *testing.T, svc *BackupService, id, path string) {
	t.Helper()
	if _, err := svc.db.Exec(
		`INSERT INTO apps (id, name, type, path, status) VALUES (?, ?, 'repo', ?, 'stopped')`,
		id, id, path,
	); err != nil {
		t.Fatalf("insert app: %v", err)
	}
}

func TestBackupServiceConfigurationAndUnavailableRestic(t *testing.T) {
	svc, _ := newStorageService(t)
	svc.SetServerSecret("changed-secret")
	svc.SetEncryptionKey("changed-key")
	if svc.serverSecret != "changed-secret" || svc.encryptionKey != "changed-key" {
		t.Fatal("service secrets were not updated")
	}
	if svc.BasePath() == "" {
		t.Fatal("base path is empty")
	}
	if svc.UseRestic() {
		t.Fatal("test service should not have restic")
	}
	if svc.DeriveRepoPassword("app") == "" {
		t.Fatal("derived password is empty")
	}
	result, err := svc.BackupApp(context.Background(), "missing", BackupOptions{})
	if err == nil || result.Error == nil || !strings.Contains(err.Error(), "require restic") {
		t.Fatalf("BackupApp = %+v, %v", result, err)
	}
	restore, err := svc.RestoreApp(context.Background(), "missing", "", RestoreOptions{})
	if err == nil || restore.Error == nil || restore.BackupID != "missing" {
		t.Fatalf("RestoreApp = %+v, %v", restore, err)
	}
	if _, _, err := svc.CreateDownloadArchive(context.Background(), "missing"); err == nil {
		t.Fatal("expected unavailable restic download error")
	}
	if err := svc.TestRepository(context.Background(), restic.RepoConfig{}); err == nil {
		t.Fatal("expected unavailable restic repository test error")
	}
	if _, err := svc.GetRepoStats(context.Background(), "missing"); err == nil {
		t.Fatal("expected unavailable restic stats error")
	}
}

func TestBackupRepositoryCRUDEncryptionAndLookup(t *testing.T) {
	svc, dir := newStorageService(t)
	ctx := context.Background()
	appPath := filepath.Join(dir, "apps", "app-1")
	insertStorageApp(t, svc, "app-1", appPath)
	now := time.Now()
	credentials, _ := json.Marshal(map[string]string{"AWS_ACCESS_KEY_ID": "key"})
	repo := &BackupRepository{
		ID:                "repo-app",
		AppID:             "app-1",
		RepoType:          "s3",
		RepoPath:          "s3:https://objects.example.com/bucket",
		Password:          "repo-password",
		Credentials:       string(credentials),
		LimitUploadKbps:   100,
		LimitDownloadKbps: 200,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := svc.CreateRepository(ctx, repo); err != nil {
		t.Fatalf("create repository: %v", err)
	}
	stored, err := svc.GetRepository(ctx, repo.ID)
	if err != nil {
		t.Fatalf("get repository: %v", err)
	}
	if stored.Password == repo.Password || stored.Credentials == repo.Credentials {
		t.Fatal("repository secrets were stored in plaintext")
	}
	key, err := svc.GetRepositoryRecoveryKey(ctx, repo.ID)
	if err != nil || key != repo.Password {
		t.Fatalf("recovery key = %q, %v", key, err)
	}
	cfg := svc.buildRepoConfigFromRepository(stored)
	if cfg.Password != repo.Password || cfg.Env["AWS_ACCESS_KEY_ID"] != "key" ||
		cfg.LimitUploadKbps != 100 || cfg.LimitDownloadKbps != 200 {
		t.Fatalf("repo config = %+v", cfg)
	}
	appRepo, err := svc.GetRepositoryForApp(ctx, "app-1")
	if err != nil || appRepo.ID != repo.ID {
		t.Fatalf("app repo = %+v, %v", appRepo, err)
	}
	gotCfg, id, err := svc.getRepoForApp(ctx, "app-1")
	if err != nil || id != repo.ID || gotCfg.Path != repo.RepoPath {
		t.Fatalf("internal app repo = %+v, %q, %v", gotCfg, id, err)
	}
	byBackup, err := svc.getRepoByBackup(ctx, &Backup{ID: "b", AppID: "app-1", RepoID: repo.ID})
	if err != nil || byBackup.Path != repo.RepoPath {
		t.Fatalf("backup repo = %+v, %v", byBackup, err)
	}

	defaultRepo := &BackupRepository{
		ID:        "repo-default",
		RepoType:  "local",
		RepoPath:  filepath.Join(dir, "default-repo"),
		Password:  "default-password",
		CreatedAt: now.Add(time.Second),
		UpdatedAt: now,
	}
	if err := svc.CreateRepository(ctx, defaultRepo); err != nil {
		t.Fatalf("create default repo: %v", err)
	}
	gotDefault, err := svc.GetDefaultRepository(ctx)
	if err != nil || gotDefault.ID != defaultRepo.ID {
		t.Fatalf("default repo = %+v, %v", gotDefault, err)
	}
	fallback, fallbackID, err := svc.getOrCreateRepoForApp(ctx, "unassigned-app")
	if err != nil || fallbackID != defaultRepo.ID || fallback.Path != defaultRepo.RepoPath {
		t.Fatalf("fallback repo = %+v, %q, %v", fallback, fallbackID, err)
	}
	fallback, err = svc.getRepoByBackup(ctx, &Backup{ID: "legacy", AppID: "unassigned-app"})
	if err != nil || fallback.Path != defaultRepo.RepoPath {
		t.Fatalf("legacy backup fallback = %+v, %v", fallback, err)
	}

	repos, err := svc.ListRepositories(ctx)
	if err != nil || len(repos) != 2 {
		t.Fatalf("repositories = %+v, %v", repos, err)
	}
	if _, err := svc.GetRepository(ctx, "missing"); err == nil {
		t.Fatal("expected missing repository error")
	}
	if _, err := svc.GetRepositoryForApp(ctx, "missing"); err == nil {
		t.Fatal("expected missing app repository error")
	}
	if _, err := svc.GetRepositoryRecoveryKey(ctx, "missing"); err == nil {
		t.Fatal("expected missing recovery key error")
	}
	if _, err := svc.getRepoByBackup(ctx, &Backup{ID: "unknown"}); err == nil {
		t.Fatal("expected indeterminate repository error")
	}
	if err := svc.DeleteRepository(ctx, repo.ID); err != nil {
		t.Fatalf("delete repository: %v", err)
	}
}

func TestBackupRepositoryValidationAndAutoCreation(t *testing.T) {
	svc, dir := newStorageService(t)
	ctx := context.Background()
	now := time.Now()
	if err := svc.CreateRepository(ctx, &BackupRepository{
		ID: "bad", RepoType: "ftp", RepoPath: "/tmp/x", Password: "p", CreatedAt: now, UpdatedAt: now,
	}); err == nil {
		t.Fatal("expected invalid repository type")
	}
	svc.encryptionKey = ""
	if err := svc.CreateRepository(ctx, &BackupRepository{
		ID: "no-key", RepoType: "local", RepoPath: "/tmp/x", Password: "p", CreatedAt: now, UpdatedAt: now,
	}); err == nil || !strings.Contains(err.Error(), "encryption key") {
		t.Fatalf("missing encryption key error = %v", err)
	}
	svc.encryptionKey = "encryption-key"
	insertStorageApp(t, svc, "auto-app", filepath.Join(dir, "apps", "auto-app"))
	cfg, repoID, err := svc.getOrCreateRepoForApp(ctx, "auto-app")
	if err != nil || repoID == "" || cfg.Type != "local" || cfg.Password == "" {
		t.Fatalf("auto repo = %+v, %q, %v", cfg, repoID, err)
	}
	if _, err := svc.GetRepository(ctx, repoID); err != nil {
		t.Fatalf("auto repository not persisted: %v", err)
	}
	if _, err := svc.getSystemRepository(ctx); err == nil {
		t.Fatal("expected missing system repository")
	}
}

func TestBackupRecordsCleanupAndQueries(t *testing.T) {
	svc, dir := newStorageService(t)
	ctx := context.Background()
	insertStorageApp(t, svc, "app-1", filepath.Join(dir, "app-1"))
	now := time.Now()
	for i, id := range []string{"new", "middle", "old"} {
		created := now.Add(-time.Duration(i) * time.Hour)
		if _, err := svc.db.Exec(`
			INSERT INTO backups (id, app_id, type, path, size, data_added, created_at, checksum, source, format, snapshot_id, repo_id)
			VALUES (?, 'app-1', 'app', ?, ?, ?, ?, ?, 'local', 'restic', '', '')`,
			id, filepath.Join(dir, id), 100+i, 10+i, created, "sum-"+id,
		); err != nil {
			t.Fatalf("insert backup: %v", err)
		}
	}
	all, err := svc.ListBackups(ctx, "")
	if err != nil || len(all) != 3 {
		t.Fatalf("all backups = %+v, %v", all, err)
	}
	filtered, err := svc.ListBackups(ctx, "app-1")
	if err != nil || len(filtered) != 3 || filtered[0].ID != "new" {
		t.Fatalf("filtered backups = %+v, %v", filtered, err)
	}
	got, err := svc.GetBackup(ctx, "new")
	if err != nil || got.Checksum != "sum-new" || got.DataAdded != 10 || got.Source != "local" {
		t.Fatalf("backup = %+v, %v", got, err)
	}
	if _, err := svc.GetBackup(ctx, "missing"); err == nil {
		t.Fatal("expected missing backup")
	}
	if err := svc.CleanupOldBackups(ctx, "app-1", 1); err != nil {
		t.Fatalf("cleanup backups: %v", err)
	}
	remaining, _ := svc.ListBackups(ctx, "app-1")
	if len(remaining) != 1 || remaining[0].ID != "new" {
		t.Fatalf("remaining backups = %+v", remaining)
	}
	if err := svc.CleanupOldBackups(ctx, "app-1", 2); err != nil {
		t.Fatalf("no-op cleanup: %v", err)
	}
	if err := svc.DeleteBackup(ctx, "missing"); err == nil {
		t.Fatal("expected delete missing backup error")
	}
}

func TestBackupScheduleCRUD(t *testing.T) {
	svc, dir := newStorageService(t)
	ctx := context.Background()
	insertStorageApp(t, svc, "scheduled", filepath.Join(dir, "scheduled"))
	now := time.Now().Round(time.Second)
	schedule := &BackupSchedule{
		ID: "schedule-1", AppID: "scheduled", Type: BackupTypeApp, CronExpr: "0 2 * * *",
		Enabled: true, Options: BackupOptions{StopBeforeBackup: true}, Retention: 7, CreatedAt: now, UpdatedAt: now,
	}
	if err := svc.CreateSchedule(ctx, schedule); err != nil {
		t.Fatalf("create schedule: %v", err)
	}
	got, err := svc.GetSchedule(ctx, schedule.ID)
	if err != nil || !got.Enabled || !got.Options.StopBeforeBackup || got.Retention != 7 {
		t.Fatalf("schedule = %+v, %v", got, err)
	}
	schedule.CronExpr = "30 3 * * *"
	schedule.Enabled = false
	schedule.Retention = 3
	if err := svc.UpdateSchedule(ctx, schedule); err != nil {
		t.Fatalf("update schedule: %v", err)
	}
	lastRun, nextRun := now.Add(time.Hour), now.Add(25*time.Hour)
	if err := svc.UpdateScheduleNextRun(ctx, schedule.ID, lastRun, nextRun); err != nil {
		t.Fatalf("update next run: %v", err)
	}
	list, err := svc.ListSchedules(ctx)
	if err != nil || len(list) != 1 || list[0].LastRun == nil || list[0].NextRun == nil ||
		list[0].CronExpr != schedule.CronExpr || list[0].Retention != 3 {
		t.Fatalf("schedules = %+v, %v", list, err)
	}
	if err := svc.DeleteSchedule(ctx, schedule.ID); err != nil {
		t.Fatalf("delete schedule: %v", err)
	}
	if _, err := svc.GetSchedule(ctx, schedule.ID); err == nil {
		t.Fatal("expected deleted schedule error")
	}
}

func TestUploadedDatabaseBackupListingAndCleanup(t *testing.T) {
	svc, dir := newStorageService(t)
	ctx := context.Background()
	first, err := svc.StoreUploadedDatabaseBackup(ctx, "first.db.gz", strings.NewReader("first"), 999)
	if err != nil {
		t.Fatalf("store first: %v", err)
	}
	if first.Size != int64(len("first")) || first.Checksum == "" {
		t.Fatalf("first backup = %+v", first)
	}
	time.Sleep(time.Millisecond)
	second, err := svc.StoreUploadedDatabaseBackup(ctx, "second.db.gz", strings.NewReader("second"), 1)
	if err != nil {
		t.Fatalf("store second: %v", err)
	}
	list, err := svc.ListDatabaseBackups(ctx)
	if err != nil || len(list) != 2 || list[0].ID != second.ID {
		t.Fatalf("database backups = %+v, %v", list, err)
	}
	if err := svc.CleanupOldDatabaseBackups(ctx, 1); err != nil {
		t.Fatalf("cleanup old database backups: %v", err)
	}
	if _, err := os.Stat(first.Path); !os.IsNotExist(err) {
		t.Fatalf("old backup still exists: %v", err)
	}
	list, _ = svc.ListDatabaseBackups(ctx)
	if len(list) != 1 || list[0].ID != second.ID {
		t.Fatalf("remaining database backups = %+v", list)
	}

	ghostPath := filepath.Join(dir, "ghost.db.gz")
	if _, err := svc.db.Exec(
		`INSERT INTO database_backups (id, path, size, created_at, checksum) VALUES ('ghost', ?, 0, ?, '')`,
		ghostPath, time.Now(),
	); err != nil {
		t.Fatalf("insert ghost: %v", err)
	}
	if err := svc.CleanupGhostDatabaseBackups(ctx); err != nil {
		t.Fatalf("cleanup ghosts: %v", err)
	}
	var ghostCount int
	if err := svc.db.QueryRow(`SELECT COUNT(*) FROM database_backups WHERE id = 'ghost'`).Scan(&ghostCount); err != nil || ghostCount != 0 {
		t.Fatalf("ghost count = %d, %v", ghostCount, err)
	}
	if err := svc.DeleteDatabaseBackupRecord(ctx, second.ID); err != nil {
		t.Fatalf("delete database record: %v", err)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }

func TestStoreUploadedDatabaseBackupErrors(t *testing.T) {
	svc, _ := newStorageService(t)
	ctx := context.Background()
	if _, err := svc.StoreUploadedDatabaseBackup(ctx, "failed.db.gz", failingReader{}, 0); err == nil ||
		!strings.Contains(err.Error(), "write database backup") {
		t.Fatalf("copy error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(svc.basePath, "database", "failed.db.gz")); !os.IsNotExist(err) {
		t.Fatalf("partial upload exists: %v", err)
	}
}

func TestCompressionChecksumArchiveAndPathHelpers(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "source.txt")
	compressed := filepath.Join(dir, "source.txt.gz")
	decompressed := filepath.Join(dir, "roundtrip.txt")
	if err := os.WriteFile(src, []byte("backup contents"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := compressFile(src, compressed); err != nil {
		t.Fatalf("compress: %v", err)
	}
	if err := decompressGzipFile(compressed, decompressed, 0o600); err != nil {
		t.Fatalf("decompress: %v", err)
	}
	raw, _ := os.ReadFile(decompressed)
	if string(raw) != "backup contents" {
		t.Fatalf("roundtrip = %q", raw)
	}
	checksum, err := fileChecksum(src)
	if err != nil || len(checksum) != 64 {
		t.Fatalf("checksum = %q, %v", checksum, err)
	}
	if _, err := fileChecksum(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("expected checksum error")
	}
	if err := compressFile(filepath.Join(dir, "missing"), compressed); err == nil {
		t.Fatal("expected compression source error")
	}
	if err := decompressGzipFile(src, filepath.Join(dir, "bad"), 0o600); err == nil {
		t.Fatal("expected invalid gzip error")
	}
	if err := decompressGzipFile(compressed, decompressed, 0o600); err == nil {
		t.Fatal("expected exclusive destination error")
	}

	tree := filepath.Join(dir, "tree")
	if err := os.MkdirAll(filepath.Join(tree, "nested"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tree, "nested", "file.txt"), []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	var archive strings.Builder
	if err := createTarGzFromDir(tree, &archive); err != nil {
		t.Fatalf("create archive: %v", err)
	}
	gz, err := gzip.NewReader(strings.NewReader(archive.String()))
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}
	tr := tar.NewReader(gz)
	var names []string
	for {
		header, nextErr := tr.Next()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			t.Fatal(nextErr)
		}
		names = append(names, header.Name)
	}
	if len(names) < 2 {
		t.Fatalf("archive entries = %v", names)
	}
	for rel, want := range map[string]bool{
		"child/file": true,
		".":          true,
		"../escape":  false,
		"/absolute":  false,
		"a/../../b":  false,
	} {
		if got := isSafeTarPath(tree, rel); got != want {
			t.Errorf("isSafeTarPath(%q) = %v, want %v", rel, got, want)
		}
	}
}

func TestFileMoveRewriteAndRestoredDirectoryHelpers(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "src.txt")
	dst := filepath.Join(root, "dst.txt")
	if err := os.WriteFile(src, []byte("copy me"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copy file: %v", err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("copyFile did not remove source: %v", err)
	}

	sourceDir := filepath.Join(root, "source-dir")
	destDir := filepath.Join(root, "dest-dir")
	if err := os.MkdirAll(filepath.Join(sourceDir, "nested"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "nested", "data"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := moveDirContents(sourceDir, destDir); err != nil {
		t.Fatalf("move dir contents: %v", err)
	}
	if _, err := os.Stat(filepath.Join(destDir, "nested", "data")); err != nil {
		t.Fatalf("moved file missing: %v", err)
	}

	appPath := filepath.Join(root, "apps", "old-id")
	if err := os.MkdirAll(filepath.Join(appPath, "app-compose"), 0o750); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".libreserv.yaml", "docker-compose.yml", filepath.Join("app-compose", "extra.yaml")} {
		path := filepath.Join(appPath, name)
		if err := os.WriteFile(path, []byte("name: old-id\npath: apps/old-id/data\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := rewriteInstanceID(appPath, "old-id", "new-id"); err != nil {
		t.Fatalf("rewrite instance: %v", err)
	}
	for _, name := range []string{".libreserv.yaml", "docker-compose.yml", filepath.Join("app-compose", "extra.yaml")} {
		raw, _ := os.ReadFile(filepath.Join(appPath, name))
		if strings.Contains(string(raw), "old-id") || !strings.Contains(string(raw), "new-id") {
			t.Errorf("rewrite %s = %q", name, raw)
		}
	}
	if err := rewriteInstanceID(appPath, "", "new"); err != nil {
		t.Fatalf("empty rewrite should be a no-op: %v", err)
	}
	unchanged := filepath.Join(root, "unchanged")
	if err := os.WriteFile(unchanged, []byte("nothing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := rewriteFileInstanceID(unchanged, "old", "new"); err != nil {
		t.Fatalf("unchanged rewrite: %v", err)
	}
	if err := rewriteFileInstanceID(filepath.Join(root, "missing"), "old", "new"); err == nil {
		t.Fatal("expected missing rewrite file error")
	}

	restoreRoot := filepath.Join(root, "restore")
	expected := filepath.Join(restoreRoot, "var", "lib", "apps", "target")
	if err := os.MkdirAll(expected, 0o750); err != nil {
		t.Fatal(err)
	}
	found, err := findRestoredAppDir(restoreRoot, "/var/lib/apps/target")
	if err != nil || found != expected {
		t.Fatalf("found restored app = %q, %v", found, err)
	}
	found, err = findRestoredAppDir(restoreRoot, "/var/lib/apps/missing")
	if err != nil || found != "" {
		t.Fatalf("missing restored app = %q, %v", found, err)
	}
}

func TestPreBackupHook(t *testing.T) {
	svc, dir := newStorageService(t)
	appPath := filepath.Join(dir, "hook-app")
	scriptDir := filepath.Join(appPath, "scripts")
	if err := os.MkdirAll(scriptDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := svc.runPreBackupHook(context.Background(), "app", appPath); err != nil {
		t.Fatalf("missing hook should be ignored: %v", err)
	}
	hook := filepath.Join(scriptDir, "system-backup")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ntest \"$LIBRESERV_APP_ID\" = app\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := svc.runPreBackupHook(context.Background(), "app", appPath); err != nil {
		t.Fatalf("successful hook: %v", err)
	}
	if err := os.WriteFile(hook, []byte("#!/bin/sh\necho failed\nexit 2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := svc.runPreBackupHook(context.Background(), "app", appPath); err == nil ||
		!strings.Contains(err.Error(), "failed") {
		t.Fatalf("failed hook error = %v", err)
	}
}
