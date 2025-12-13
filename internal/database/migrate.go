package database

import (
	_ "embed"
	"fmt"
)

//go:embed migrations/001_initial.sql
var initialSchema string

func (d *DB) Migrate() error {
	// Simple migration runner for now.
	// In the future, we should track versions in a table.
	if _, err := d.db.Exec(initialSchema); err != nil {
		return fmt.Errorf("migration failed: %w", err)
	}
	return nil
}
