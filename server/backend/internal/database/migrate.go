package database

import (
	"embed"
	"fmt"
	"log"
	"log/slog"
	"sort"
	"strings"
	"time"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrate applies pending database migrations.
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

	// Check if any migration actually needs to run
	var needsMigration bool
	for _, file := range files {
		var exists bool
		_ = d.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)`, file).Scan(&exists)
		if !exists {
			needsMigration = true
			break
		}
	}

	if !needsMigration {
		return nil
	}

	// 3. Dry-run: ensure all pending migrations are syntactically valid together
	if err := d.dryRunMigrations(files); err != nil {
		return fmt.Errorf("migration dry-run failed: %w", err)
	}

	// 4. Backup database before migration
	backupPath := d.path + ".pre-migration-" + time.Now().Format("20060102-150405")
	slog.Info("Backing up database before migration", "path", backupPath)
	if err := CopyFile(d.path, backupPath); err != nil {
		return fmt.Errorf("pre-migration backup failed: %w", err)
	}

	// 5. Run migrations in order
	for _, file := range files {
		if err := d.runMigration(file); err != nil {
			// Migration failed - rollback the database file to the pre-migration state
			slog.Error("Migration failed, attempting automatic rollback", "file", file, "error", err)

			// Close current connection to release locks
			_ = d.db.Close()

			// Restore the backup
			if rErr := CopyFile(backupPath, d.path); rErr != nil {
				slog.Error("CRITICAL: Failed to restore database backup after migration failure", "backup", backupPath, "error", rErr)
				return fmt.Errorf("migration %s failed and rollback failed: %w (backup at %s)", file, rErr, backupPath)
			}

			// Reopen database
			newDB, oErr := Open(d.path)
			if oErr != nil {
				slog.Error("CRITICAL: Failed to reopen database after rollback", "error", oErr)
				return fmt.Errorf("migration %s failed, rolled back, but failed to reopen: %w", file, oErr)
			}
			d.db = newDB.db

			return fmt.Errorf("migration %s failed: %w (database rolled back to pre-migration state)", file, err)
		}
	}

	// 6. Legacy/Cleanup migrations (best effort to ensure schema is correct if initial was already run)
	if err := d.ensureBackupsChecksum(); err != nil {
		return err
	}
	if err := d.ensureUpdatesBackupID(); err != nil {
		return err
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

// ensureBackupsChecksum backfills the checksum column for backups if missing.
func (d *DB) ensureBackupsChecksum() error {
	rows, err := d.db.Query(`PRAGMA table_info(backups)`)
	if err != nil {
		return fmt.Errorf("check backups schema: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			log.Printf("failed to close rows: %v", cerr)
		}
	}()

	for rows.Next() {
		var (
			cid       int
			name      string
			ctype     string
			notnull   int
			dfltValue interface{}
			pk        int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err == nil {
			if strings.EqualFold(name, "checksum") {
				return nil
			}
		}
	}
	if _, err := d.db.Exec(`ALTER TABLE backups ADD COLUMN checksum TEXT`); err != nil {
		return fmt.Errorf("add backups.checksum: %w", err)
	}
	return nil
}

// ensureUpdatesBackupID backfills the backup_id column for updates if missing.
func (d *DB) ensureUpdatesBackupID() error {
	rows, err := d.db.Query(`PRAGMA table_info(updates)`)
	if err != nil {
		return fmt.Errorf("check updates schema: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			log.Printf("failed to close rows: %v", cerr)
		}
	}()

	for rows.Next() {
		var (
			cid       int
			name      string
			ctype     string
			notnull   int
			dfltValue interface{}
			pk        int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err == nil {
			if strings.EqualFold(name, "backup_id") {
				return nil
			}
		}
	}
	if _, err := d.db.Exec(`ALTER TABLE updates ADD COLUMN backup_id TEXT`); err != nil {
		return fmt.Errorf("add updates.backup_id: %w", err)
	}
	return nil
}
