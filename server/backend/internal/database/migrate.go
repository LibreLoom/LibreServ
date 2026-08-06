package database

import (
	"database/sql"
	"embed"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrate applies pending database migrations.
// SQL migrations run first (if any), then cleanup/legacy migrations always run.
func (d *DB) Migrate() error {
	// 1. Ensure schema_migrations table exists
	if err := d.ensureMigrationTable(); err != nil {
		return err
	}

	// 2. Load all migration files from embedded FS
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}

	var files []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)

	// 3. Check if any SQL migration actually needs to run
	var needsMigration bool
	for _, file := range files {
		var exists bool
		_ = d.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)`, file).Scan(&exists)
		if !exists {
			needsMigration = true
			break
		}
	}

	// 4. Run pending SQL migrations (if any)
	if needsMigration {
		// 4a. Dry-run: ensure all pending migrations are syntactically valid together
		if err := d.dryRunMigrations(files); err != nil {
			return fmt.Errorf("migration dry-run failed: %w", err)
		}

		// 4b. Checkpoint WAL to ensure all data is in the main DB file before backup.
		if _, err := d.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
			slog.Warn("WAL checkpoint before migration backup failed (non-fatal)", "error", err)
		}

		// 4c. Backup database before migration
		backupPath := d.path + ".pre-migration-" + time.Now().Format("20060102-150405")
		slog.Info("Backing up database before migration", "path", backupPath)
		if err := CopyFile(d.path, backupPath); err != nil {
			return fmt.Errorf("pre-migration backup failed: %w", err)
		}

		// 4d. Run migrations in order
		for _, file := range files {
			if err := d.runMigration(file); err != nil {
				// Migration failed - rollback the database file to the pre-migration state
				slog.Error("Migration failed, attempting automatic rollback", "file", file, "error", err)

				_ = d.db.Close()

				if rErr := CopyFile(backupPath, d.path); rErr != nil {
					slog.Error("CRITICAL: Failed to restore database backup after migration failure", "backup", backupPath, "error", rErr)
					return fmt.Errorf("migration %s failed and rollback failed: %w (backup at %s)", file, rErr, backupPath)
				}

				newDB, oErr := Open(d.path)
				if oErr != nil {
					slog.Error("CRITICAL: Failed to reopen database after rollback", "error", oErr)
					return fmt.Errorf("migration %s failed, rolled back, but failed to reopen: %w", file, oErr)
				}
				d.db = newDB.db

				return fmt.Errorf("migration %s failed: %w (database rolled back to pre-migration state)", file, err)
			}
		}

		// Clean up pre-migration backup on success
		if err := os.Remove(backupPath); err != nil && !os.IsNotExist(err) {
			slog.Warn("Failed to remove pre-migration backup", "path", backupPath, "error", err)
		}
	}

	// 5. Schema reconciliation (always run — ensures schema is correct even when SQL
	// migration files were updated in-place after initial application).
	if err := d.reconcileSchema(); err != nil {
		slog.Warn("Schema reconciliation had issues (non-fatal)", "error", err)
	}

	return nil
}

func (d *DB) dryRunMigrations(files []string) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, file := range files {
		// Check if already applied
		var exists bool
		err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)`, file).Scan(&exists)
		if err != nil {
			// Table might not exist yet if 001 is pending
			exists = false
		}
		if exists {
			continue
		}

		content, err := migrationFS.ReadFile("migrations/" + file)
		if err != nil {
			return err
		}

		if _, err := tx.Exec(string(content)); err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
	}

	return tx.Rollback()
}

func (d *DB) ensureMigrationTable() error {
	_, err := d.db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`)
	return err
}

func (d *DB) runMigration(filename string) error {
	// Check if already applied
	var exists bool
	err := d.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)`, filename).Scan(&exists)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}

	// Read migration content
	content, err := migrationFS.ReadFile("migrations/" + filename)
	if err != nil {
		return err
	}

	// Run in transaction
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Split by semicolon for basic multiple statements support if needed,
	// but SQLite Exec handles multiple statements fine usually.
	if _, err := tx.Exec(string(content)); err != nil {
		return fmt.Errorf("exec migration: %w", err)
	}

	// Record success
	if _, err := tx.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, filename); err != nil {
		return fmt.Errorf("record migration: %w", err)
	}

	return tx.Commit()
}

// reconcileSchema brings an existing database up to the current 001_schema.sql
// without creating a new migration file. It adds missing columns/tables and
// drops deprecated ones. This handles the case where 001 was already applied
// with an older version of the schema.
func (d *DB) reconcileSchema() error {
	existingTables := d.getExistingTables()
	existingColumns := d.getExistingColumns()

	// Add missing tables (CREATE IF NOT EXISTS is safe)
	missingTables := map[string]string{
		"backup_repositories": `
			CREATE TABLE IF NOT EXISTS backup_repositories (
				id TEXT PRIMARY KEY,
				app_id TEXT,
				repo_type TEXT NOT NULL CHECK(repo_type IN ('local', 's3', 'b2', 'sftp')),
				repo_path TEXT NOT NULL,
				password TEXT NOT NULL,
				credentials TEXT,
				is_system BOOLEAN DEFAULT 0,
				limit_upload_kbps INTEGER DEFAULT 0,
				limit_download_kbps INTEGER DEFAULT 0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
			)`,
	}
	for table, ddl := range missingTables {
		if !existingTables[table] {
			if _, err := d.db.Exec(ddl); err != nil {
				slog.Warn("Failed to create missing table", "table", table, "error", err)
			}
		}
	}

	// Add missing columns
	missingColumns := map[string]map[string]string{
		"backups": {
			"format":      `ALTER TABLE backups ADD COLUMN format TEXT DEFAULT 'tar'`,
			"snapshot_id": `ALTER TABLE backups ADD COLUMN snapshot_id TEXT`,
			"repo_id":     `ALTER TABLE backups ADD COLUMN repo_id TEXT`,
			"data_added":  `ALTER TABLE backups ADD COLUMN data_added INTEGER DEFAULT 0`,
		},
		"backup_repositories": {
			"is_system": `ALTER TABLE backup_repositories ADD COLUMN is_system BOOLEAN DEFAULT 0`,
		},
		"updates": {
			"backup_id": `ALTER TABLE updates ADD COLUMN backup_id TEXT`,
		},
		"user_security_settings": {
			"use_12_hour_time":          `ALTER TABLE user_security_settings ADD COLUMN use_12_hour_time BOOLEAN DEFAULT 0`,
			"notify_on_app_updates":     `ALTER TABLE user_security_settings ADD COLUMN notify_on_app_updates BOOLEAN DEFAULT 1`,
			"notify_on_user_management": `ALTER TABLE user_security_settings ADD COLUMN notify_on_user_management BOOLEAN DEFAULT 1`,
		},
		"apps": {
			"revocation_revoked_at":      `ALTER TABLE apps ADD COLUMN revocation_revoked_at TIMESTAMP`,
			"revocation_acknowledged_at": `ALTER TABLE apps ADD COLUMN revocation_acknowledged_at TIMESTAMP`,
		},
	}
	for table, columns := range missingColumns {
		for col, ddl := range columns {
			if !existingColumns[table][col] {
				if _, err := d.db.Exec(ddl); err != nil {
					slog.Warn("Failed to add missing column", "table", table, "column", col, "error", err)
				}
			}
		}
	}

	// Add missing indexes
	missingIndexes := map[string]string{
		"idx_backup_repositories_app":  `CREATE INDEX IF NOT EXISTS idx_backup_repositories_app ON backup_repositories(app_id)`,
		"idx_backup_repositories_type": `CREATE INDEX IF NOT EXISTS idx_backup_repositories_type ON backup_repositories(repo_type)`,
	}
	for idx, ddl := range missingIndexes {
		var exists bool
		_ = d.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?)`, idx).Scan(&exists)
		if !exists {
			if _, err := d.db.Exec(ddl); err != nil {
				slog.Warn("Failed to create missing index", "index", idx, "error", err)
			}
		}
	}

	// Ensure revoked_tokens.token_jti has a UNIQUE constraint.
	// SQLite cannot ALTER a column to add UNIQUE, so we recreate the table
	// if the constraint is missing. Without it, INSERT OR IGNORE in
	// RevokeTokenIfNotRevoked never detects duplicates, breaking token
	// rotation reuse detection.
	if existingTables["revoked_tokens"] && !d.hasUniqueIndex("revoked_tokens", "token_jti") {
		slog.Warn("Recreating revoked_tokens table to add UNIQUE constraint on token_jti")
		if err := d.recreateRevokedTokensTable(); err != nil {
			slog.Error("Failed to recreate revoked_tokens with UNIQUE constraint", "error", err)
		}
	}
	for idx, ddl := range missingIndexes {
		var exists bool
		_ = d.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?)`, idx).Scan(&exists)
		if !exists {
			if _, err := d.db.Exec(ddl); err != nil {
				slog.Warn("Failed to create missing index", "index", idx, "error", err)
			}
		}
	}

	// Migrate data from deprecated tables before dropping them.
	// cloud_backup_config → backup_repositories (config data maps cleanly).
	if existingTables["cloud_backup_config"] {
		d.migrateCloudBackupConfig()
	}

	// cloud_backups tracked remote-upload metadata (backup_id → remote_path,
	// uploaded_at) — it was NOT a standalone backup record. The actual backup
	// data already lives in the backups table, so there is nothing meaningful
	// to migrate. We log the row count for visibility and drop the table.
	if existingTables["cloud_backups"] {
		var count int
		if err := d.db.QueryRow(`SELECT COUNT(*) FROM cloud_backups`).Scan(&count); err == nil && count > 0 {
			slog.Warn("Dropping cloud_backups table with data (upload-tracking metadata, not restorable backups)",
				"rows", count,
				"note", "actual backup records are already in the backups table")
		}
	}

	// Drop deprecated tables (data migrated or logged above)
	deprecatedTables := []string{"cloud_backup_config", "cloud_backups"}
	for _, table := range deprecatedTables {
		if existingTables[table] {
			slog.Warn("Dropping deprecated table", "table", table)
			if _, err := d.db.Exec(fmt.Sprintf(`DROP TABLE IF EXISTS "%s"`, table)); err != nil {
				slog.Warn("Failed to drop deprecated table", "table", table, "error", err)
			}
		}
	}

	return nil
}

func (d *DB) getExistingTables() map[string]bool {
	tables := make(map[string]bool)
	rows, err := d.db.Query(`SELECT name FROM sqlite_master WHERE type='table'`)
	if err != nil {
		return tables
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			tables[name] = true
		}
	}
	return tables
}

func (d *DB) getExistingColumns() map[string]map[string]bool {
	result := make(map[string]map[string]bool)
	tables := d.getExistingTables()
	for table := range tables {
		if table == "schema_migrations" {
			continue
		}
		if !isValidIdentifier(table) {
			slog.Warn("Skipping table with invalid identifier", "table", table)
			continue
		}
		columns := make(map[string]bool)
		rows, err := d.db.Query(fmt.Sprintf(`PRAGMA table_info("%s")`, table))
		if err != nil {
			continue
		}
		for rows.Next() {
			var cid int
			var name, ctype string
			var notnull int
			var dfltValue interface{}
			var pk int
			if rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk) == nil {
				columns[strings.ToLower(name)] = true
			}
		}
		rows.Close()
		result[table] = columns
	}
	return result
}

var validIdentifierRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

func isValidIdentifier(name string) bool {
	return validIdentifierRe.MatchString(name)
}

// hasUniqueIndex checks whether a table has a UNIQUE index on the given column.
func (d *DB) hasUniqueIndex(table, column string) bool {
	rows, err := d.db.Query(`PRAGMA index_list(?)`, table)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var seq int
		var name, origin string
		var partial int
		if rows.Scan(&seq, &name, &origin, &partial) != nil {
			continue
		}
		if origin != "c" && origin != "u" {
			continue
		}
		colRows, err := d.db.Query(`PRAGMA index_info(?)`, name)
		if err != nil {
			continue
		}
		for colRows.Next() {
			var seqNo, cid int
			var colName *string
			if colRows.Scan(&seqNo, &cid, &colName) == nil && colName != nil && strings.EqualFold(*colName, column) {
				colRows.Close()
				return true
			}
		}
		colRows.Close()
	}
	return false
}

// recreateRevokedTokensTable rebuilds the revoked_tokens table with a UNIQUE
// constraint on token_jti. SQLite cannot alter a column constraint in-place,
// so the standard create-rename swap is required.
func (d *DB) recreateRevokedTokensTable() error {
	stmts := []string{
		`CREATE TABLE revoked_tokens_new (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			token_jti TEXT NOT NULL UNIQUE,
			user_id TEXT NOT NULL,
			token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
			revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			revoked_by TEXT,
			reason TEXT,
			expires_at TIMESTAMP NOT NULL
		)`,
		`INSERT INTO revoked_tokens_new (id, token_jti, user_id, token_type, revoked_at, revoked_by, reason, expires_at)
		 SELECT id, token_jti, user_id, token_type, revoked_at, revoked_by, reason, expires_at FROM revoked_tokens`,
		`DROP TABLE revoked_tokens`,
		`ALTER TABLE revoked_tokens_new RENAME TO revoked_tokens`,
		`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user ON revoked_tokens(user_id, token_type)`,
		`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at)`,
	}

	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	for _, s := range stmts {
		if _, err := tx.Exec(s); err != nil {
			return fmt.Errorf("exec: %s: %w", s, err)
		}
	}
	return tx.Commit()
}

// migrateCloudBackupConfig migrates rows from the deprecated cloud_backup_config
// table into backup_repositories. Rows that cannot be migrated (e.g. missing
// required fields) are logged and skipped rather than blocking startup.
func (d *DB) migrateCloudBackupConfig() {
	// Check if there's any data to migrate
	var count int
	err := d.db.QueryRow(`SELECT COUNT(*) FROM cloud_backup_config`).Scan(&count)
	if err != nil {
		slog.Warn("Could not count cloud_backup_config rows (skipping migration)", "error", err)
		return
	}
	if count == 0 {
		slog.Info("cloud_backup_config is empty, no data to migrate")
		return
	}

	slog.Info("Migrating cloud_backup_config data to backup_repositories", "rows", count)

	// Inspect available columns — older schemas may not have all fields.
	cols := d.getExistingColumns()
	ccCols := cols["cloud_backup_config"]

	// Build query dynamically based on what columns exist
	selectCols := []string{"id"}
	if ccCols["app_id"] {
		selectCols = append(selectCols, "app_id")
	}
	if ccCols["repo_type"] {
		selectCols = append(selectCols, "repo_type")
	} else {
		selectCols = append(selectCols, "'s3' AS repo_type")
	}
	if ccCols["repo_path"] {
		selectCols = append(selectCols, "repo_path")
	} else {
		selectCols = append(selectCols, "'' AS repo_path")
	}
	if ccCols["password"] {
		selectCols = append(selectCols, "password")
	} else {
		selectCols = append(selectCols, "'' AS password")
	}
	if ccCols["credentials"] {
		selectCols = append(selectCols, "credentials")
	} else {
		selectCols = append(selectCols, "NULL AS credentials")
	}
	if ccCols["created_at"] {
		selectCols = append(selectCols, "created_at")
	} else {
		selectCols = append(selectCols, "CURRENT_TIMESTAMP AS created_at")
	}

	query := fmt.Sprintf("SELECT %s FROM cloud_backup_config", strings.Join(selectCols, ", "))
	rows, err := d.db.Query(query)
	if err != nil {
		slog.Error("Failed to query cloud_backup_config for migration", "error", err)
		return
	}
	defer rows.Close()

	migrated, skipped := 0, 0
	for rows.Next() {
		var id, repoType, repoPath, password, createdAt string
		var appID, credentials sql.NullString

		if err := rows.Scan(&id, &appID, &repoType, &repoPath, &password, &credentials, &createdAt); err != nil {
			slog.Error("Failed to scan cloud_backup_config row", "error", err)
			skipped++
			continue
		}

		if repoPath == "" {
			slog.Warn("Skipping cloud_backup_config row with empty repo_path", "id", id)
			skipped++
			continue
		}

		var appIDVal interface{}
		if appID.Valid && appID.String != "" {
			appIDVal = appID.String
		}

		_, err := d.db.Exec(`
			INSERT OR IGNORE INTO backup_repositories
				(id, app_id, repo_type, repo_path, password, credentials, is_system, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
			id, appIDVal, repoType, repoPath, password, credentials, createdAt, createdAt)
		if err != nil {
			slog.Error("Failed to migrate cloud_backup_config row", "id", id, "error", err)
			skipped++
			continue
		}
		migrated++
	}

	slog.Info("cloud_backup_config migration complete", "migrated", migrated, "skipped", skipped)
}
