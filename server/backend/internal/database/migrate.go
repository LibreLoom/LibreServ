package database

import (
	_ "embed"
	"fmt"
	"strings"
)

//go:embed migrations/001_initial.sql
var initialSchema string

func (d *DB) Migrate() error {
	// Simple migration runner for now.
	// In the future, we should track versions in a table.
	if _, err := d.db.Exec(initialSchema); err != nil {
		return fmt.Errorf("migration failed: %w", err)
	}
	if err := d.ensureBackupsChecksum(); err != nil {
		return err
	}
	return nil
}

// ensureBackupsChecksum backfills the checksum column for backups if missing.
func (d *DB) ensureBackupsChecksum() error {
	rows, err := d.db.Query(`PRAGMA table_info(backups)`)
	if err != nil {
		return fmt.Errorf("check backups schema: %w", err)
	}
	defer rows.Close()

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
