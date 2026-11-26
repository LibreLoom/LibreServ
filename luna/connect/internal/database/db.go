package database

import "fmt"

// Migrate creates the schema. Connect is in early development with no data to
// preserve, so the schema is rewritten in place rather than migrated.
func Migrate(db *DB) error {
	if db == nil {
		return fmt.Errorf("migrate: nil db")
	}
	schema := schemaSQLite
	name := "sqlite"
	if db.driver == DriverPostgres {
		schema = schemaPostgres
		name = "postgres"
	}
	if _, err := db.Exec(schema); err != nil {
		return fmt.Errorf("migrate %s schema: %w", name, err)
	}
	return nil
}
