package database

import (
	"context"
	"testing"
)

func TestReplaceFileSwapsDatabase(t *testing.T) {
	dir := t.TempDir()

	orig, err := Open(dir + "/orig.db")
	if err != nil {
		t.Fatalf("open original db: %v", err)
	}
	if err := orig.Migrate(); err != nil {
		t.Fatalf("migrate original: %v", err)
	}

	replace, err := Open(dir + "/replacement.db")
	if err != nil {
		t.Fatalf("open replacement db: %v", err)
	}
	if err := replace.Migrate(); err != nil {
		t.Fatalf("migrate replacement: %v", err)
	}
	if _, err := replace.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('id1','user1','hash')`); err != nil {
		t.Fatalf("seed replacement: %v", err)
	}
	_ = replace.Close()

	if err := orig.ReplaceFile(context.Background(), dir+"/replacement.db"); err != nil {
		t.Fatalf("replace file failed: %v", err)
	}
	defer orig.Close()

	var username string
	if err := orig.db.QueryRow(`SELECT username FROM users WHERE id='id1'`).Scan(&username); err != nil {
		t.Fatalf("query swapped db: %v", err)
	}
	if username != "user1" {
		t.Fatalf("unexpected username after swap: %q", username)
	}
}

func TestReconcileSchemaAddsMissingColumnsAndTables(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir + "/test.db")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	tables := db.getExistingTables()
	if !tables["backup_repositories"] {
		t.Error("backup_repositories table missing after fresh migration")
	}

	columns := db.getExistingColumns()
	if !columns["backups"]["format"] {
		t.Error("backups.format column missing after fresh migration")
	}
	if !columns["backups"]["data_added"] {
		t.Error("backups.data_added column missing after fresh migration")
	}
	if !columns["updates"]["backup_id"] {
		t.Error("updates.backup_id column missing after fresh migration")
	}
	if !columns["user_security_settings"]["use_12_hour_time"] {
		t.Error("user_security_settings.use_12_hour_time column missing after fresh migration")
	}
	if tables["cloud_backup_config"] {
		t.Error("cloud_backup_config table should not exist after fresh migration")
	}
	if tables["cloud_backups"] {
		t.Error("cloud_backups table should not exist after fresh migration")
	}
}

func TestReconcileSchemaRepairsOldDatabase(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir + "/test.db")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	oldSchema := `
	CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, email TEXT, role TEXT DEFAULT 'user', last_login TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, source TEXT, path TEXT NOT NULL, status TEXT DEFAULT 'stopped', health_status TEXT DEFAULT 'unknown', pinned_version TEXT, error TEXT, installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, metadata JSON, image_digest TEXT, compose_template_sha TEXT, revocation_severity TEXT, revocation_reason TEXT);
	CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, app_id TEXT, type TEXT NOT NULL, path TEXT NOT NULL, size INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, checksum TEXT, source TEXT DEFAULT 'local', FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE SET NULL);
	CREATE TABLE IF NOT EXISTS cloud_backup_config (id TEXT PRIMARY KEY, provider TEXT NOT NULL, bucket TEXT, region TEXT, key_id TEXT, key_secret TEXT, endpoint TEXT, enabled INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE IF NOT EXISTS cloud_backups (id TEXT PRIMARY KEY, backup_id TEXT NOT NULL, remote_path TEXT NOT NULL, size INTEGER DEFAULT 0, uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE);
	CREATE TABLE IF NOT EXISTS backup_schedules (id TEXT PRIMARY KEY, app_id TEXT, type TEXT NOT NULL, cron_expr TEXT NOT NULL, enabled BOOLEAN DEFAULT TRUE, stop_before_backup BOOLEAN DEFAULT FALSE, compress BOOLEAN DEFAULT TRUE, include_config BOOLEAN DEFAULT TRUE, include_logs BOOLEAN DEFAULT FALSE, retention INTEGER DEFAULT 7, last_run TIMESTAMP, next_run TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE);
	INSERT INTO schema_migrations (version) VALUES ('001_schema.sql');
	`
	if _, err := db.Exec(oldSchema); err != nil {
		t.Fatalf("create old schema: %v", err)
	}

	if err := db.reconcileSchema(); err != nil {
		t.Fatalf("reconcileSchema: %v", err)
	}

	tables := db.getExistingTables()
	if !tables["backup_repositories"] {
		t.Error("backup_repositories table missing after reconcile")
	}
	if tables["cloud_backup_config"] {
		t.Error("cloud_backup_config table should be dropped after reconcile")
	}
	if tables["cloud_backups"] {
		t.Error("cloud_backups table should be dropped after reconcile")
	}

	columns := db.getExistingColumns()
	if !columns["backups"]["format"] {
		t.Error("backups.format column missing after reconcile")
	}
	if !columns["backups"]["data_added"] {
		t.Error("backups.data_added column missing after reconcile")
	}
	if !columns["backups"]["snapshot_id"] {
		t.Error("backups.snapshot_id column missing after reconcile")
	}
	if !columns["backups"]["repo_id"] {
		t.Error("backups.repo_id column missing after reconcile")
	}
	if !columns["apps"]["revocation_revoked_at"] {
		t.Error("apps.revocation_revoked_at column missing after reconcile")
	}
	if !columns["apps"]["revocation_acknowledged_at"] {
		t.Error("apps.revocation_acknowledged_at column missing after reconcile")
	}

	var migrationVersion string
	if err := db.QueryRow("SELECT version FROM schema_migrations WHERE version = '001_schema.sql'").Scan(&migrationVersion); err != nil {
		t.Errorf("schema_migrations record missing or incorrect after reconcile: %v", err)
	}
	if migrationVersion != "001_schema.sql" {
		t.Errorf("schema_migrations version = %q, want %q", migrationVersion, "001_schema.sql")
	}
}
