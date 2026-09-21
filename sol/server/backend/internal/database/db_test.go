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

func TestFreshMigrationCreatesConsolidatedSchema(t *testing.T) {
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
	required := []string{
		"backup_repositories",
		"api_tokens",
		"mfa_methods",
		"mfa_recovery_codes",
		"invite_tokens",
		"oidc_clients",
		"oidc_consent",
		"app_access",
		"oidc_signing_keys",
		"path_state",
	}
	for _, name := range required {
		if !tables[name] {
			t.Errorf("%s table missing after fresh migration", name)
		}
	}

	// Legacy support tables must not be created by the consolidated schema.
	if tables["support_sessions"] {
		t.Error("support_sessions should not exist after fresh migration")
	}
	if tables["support_audit"] {
		t.Error("support_audit should not exist after fresh migration")
	}
	if tables["cloud_backup_config"] {
		t.Error("cloud_backup_config table should not exist after fresh migration")
	}
	if tables["cloud_backups"] {
		t.Error("cloud_backups table should not exist after fresh migration")
	}

	columns := db.getExistingColumns()
	checks := map[string][]string{
		"backups":                {"format", "data_added"},
		"updates":                {"backup_id"},
		"user_security_settings": {"use_12_hour_time", "notify_on_app_updates", "notify_on_user_management"},
		"users":                  {"mfa_required"},
		"routes":                 {"restricted_access"},
		"dns_provider_configs":   {"nameserver", "tsig_key_name", "tsig_secret", "hmac_algorithm"},
	}
	for table, cols := range checks {
		for _, col := range cols {
			if !columns[table][col] {
				t.Errorf("%s.%s column missing after fresh migration", table, col)
			}
		}
	}

	var versionCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&versionCount); err != nil {
		t.Fatalf("count schema_migrations: %v", err)
	}
	if versionCount != 1 {
		t.Errorf("schema_migrations row count = %d, want 1", versionCount)
	}
	var version string
	if err := db.QueryRow(`SELECT version FROM schema_migrations`).Scan(&version); err != nil {
		t.Fatalf("read schema_migrations version: %v", err)
	}
	if version != consolidatedMigrationVersion {
		t.Errorf("schema_migrations version = %q, want %q", version, consolidatedMigrationVersion)
	}

	var oidcIdx bool
	_ = db.QueryRow(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?)`, "idx_oidc_signing_keys_single_current").Scan(&oidcIdx)
	if !oidcIdx {
		t.Error("idx_oidc_signing_keys_single_current missing after fresh migration")
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
	CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, subdomain TEXT NOT NULL, domain TEXT NOT NULL, backend TEXT NOT NULL, app_id TEXT, ssl BOOLEAN DEFAULT TRUE, enabled BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(subdomain, domain));
	CREATE TABLE IF NOT EXISTS dns_provider_configs (id TEXT PRIMARY KEY, provider TEXT NOT NULL, domain TEXT NOT NULL, api_token TEXT NOT NULL, enabled BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE IF NOT EXISTS cloud_backup_config (id TEXT PRIMARY KEY, provider TEXT NOT NULL, bucket TEXT, region TEXT, key_id TEXT, key_secret TEXT, endpoint TEXT, enabled INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE IF NOT EXISTS cloud_backups (id TEXT PRIMARY KEY, backup_id TEXT NOT NULL, remote_path TEXT NOT NULL, size INTEGER DEFAULT 0, uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE);
	CREATE TABLE IF NOT EXISTS backup_schedules (id TEXT PRIMARY KEY, app_id TEXT, type TEXT NOT NULL, cron_expr TEXT NOT NULL, enabled BOOLEAN DEFAULT TRUE, stop_before_backup BOOLEAN DEFAULT FALSE, compress BOOLEAN DEFAULT TRUE, include_config BOOLEAN DEFAULT TRUE, include_logs BOOLEAN DEFAULT FALSE, retention INTEGER DEFAULT 7, last_run TIMESTAMP, next_run TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE);
	CREATE TABLE IF NOT EXISTS support_sessions (id TEXT PRIMARY KEY, code TEXT NOT NULL, token TEXT NOT NULL, scopes TEXT NOT NULL, status TEXT NOT NULL, expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP NOT NULL);
	CREATE TABLE IF NOT EXISTS support_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, actor TEXT, action TEXT, occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
	INSERT INTO schema_migrations (version) VALUES ('001_schema.sql');
	`
	if _, err := db.Exec(oldSchema); err != nil {
		t.Fatalf("create old schema: %v", err)
	}

	if err := db.reconcileSchema(); err != nil {
		t.Fatalf("reconcileSchema: %v", err)
	}

	tables := db.getExistingTables()
	for _, name := range []string{"backup_repositories", "api_tokens", "mfa_methods", "invite_tokens", "oidc_clients", "path_state"} {
		if !tables[name] {
			t.Errorf("%s table missing after reconcile", name)
		}
	}
	for _, name := range []string{"cloud_backup_config", "cloud_backups", "support_sessions", "support_audit"} {
		if tables[name] {
			t.Errorf("%s table should be dropped after reconcile", name)
		}
	}

	columns := db.getExistingColumns()
	checks := map[string][]string{
		"backups":              {"format", "data_added", "snapshot_id", "repo_id"},
		"apps":                 {"revocation_revoked_at", "revocation_acknowledged_at"},
		"users":                {"mfa_required"},
		"routes":               {"restricted_access"},
		"dns_provider_configs": {"nameserver", "tsig_key_name", "tsig_secret", "hmac_algorithm"},
	}
	for table, cols := range checks {
		for _, col := range cols {
			if !columns[table][col] {
				t.Errorf("%s.%s column missing after reconcile", table, col)
			}
		}
	}

	var migrationVersion string
	if err := db.QueryRow("SELECT version FROM schema_migrations WHERE version = '001_schema.sql'").Scan(&migrationVersion); err != nil {
		t.Errorf("schema_migrations record missing or incorrect after reconcile: %v", err)
	}
	if migrationVersion != "001_schema.sql" {
		t.Errorf("schema_migrations version = %q, want %q", migrationVersion, "001_schema.sql")
	}
}

func TestReconcileMigrationVersionsCollapsesLegacyRows(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir + "/test.db")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	if err := db.ensureMigrationTable(); err != nil {
		t.Fatalf("ensureMigrationTable: %v", err)
	}

	// Simulate a DB that applied the old multi-file migrations (no 001 row yet —
	// unusual but must still collapse cleanly).
	for _, v := range []string{
		"002_api_tokens.sql",
		"003_mfa.sql",
		"009_drop_legacy_support.sql",
	} {
		if _, err := db.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, v); err != nil {
			t.Fatalf("seed legacy version %s: %v", v, err)
		}
	}

	if err := db.reconcileMigrationVersions(); err != nil {
		t.Fatalf("reconcileMigrationVersions: %v", err)
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("schema_migrations count = %d, want 1", count)
	}
	var version string
	if err := db.QueryRow(`SELECT version FROM schema_migrations`).Scan(&version); err != nil {
		t.Fatalf("read version: %v", err)
	}
	if version != consolidatedMigrationVersion {
		t.Errorf("version = %q, want %q", version, consolidatedMigrationVersion)
	}
}

func TestMigrateWithLegacyVersionsDoesNotRerunSchema(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir + "/test.db")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	// First migrate to get a full schema, then rewrite schema_migrations to look
	// like a pre-squash install that recorded 001–009.
	if err := db.Migrate(); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM schema_migrations`); err != nil {
		t.Fatalf("clear migrations: %v", err)
	}
	for _, v := range append([]string{consolidatedMigrationVersion}, legacyMigrationVersions...) {
		if _, err := db.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, v); err != nil {
			t.Fatalf("seed %s: %v", v, err)
		}
	}

	// Seed a row that must survive — proves we did not wipe/rebuild tables.
	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1','keepme','hash')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	if err := db.Migrate(); err != nil {
		t.Fatalf("second migrate with legacy versions: %v", err)
	}

	var username string
	if err := db.QueryRow(`SELECT username FROM users WHERE id='u1'`).Scan(&username); err != nil {
		t.Fatalf("user lost after remigrate: %v", err)
	}
	if username != "keepme" {
		t.Errorf("username = %q, want keepme", username)
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("schema_migrations count = %d after remigrate, want 1", count)
	}
	for _, v := range legacyMigrationVersions {
		var exists bool
		_ = db.QueryRow(`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)`, v).Scan(&exists)
		if exists {
			t.Errorf("legacy version %s still present after remigrate", v)
		}
	}
}
