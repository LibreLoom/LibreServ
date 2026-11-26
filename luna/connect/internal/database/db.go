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
	if err := rejectOldDeviceModel(db); err != nil {
		return err
	}
	if _, err := db.Exec(schema); err != nil {
		return fmt.Errorf("migrate %s schema: %w", name, err)
	}
	return nil
}

// rejectOldDeviceModel refuses a database from before device tokens replaced
// the public Device ID: its rows could be paired with the Device ID alone.
func rejectOldDeviceModel(db *DB) error {
	var n int
	var err error
	if db.driver == DriverPostgres {
		err = db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'devices' AND column_name = 'device_uid'`).Scan(&n)
	} else {
		err = db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('devices') WHERE name = 'device_uid'`).Scan(&n)
	}
	if err != nil {
		return fmt.Errorf("migrate: check device model: %w", err)
	}
	if n > 0 {
		return fmt.Errorf("migrate: this database uses the old device model; start with a fresh database")
	}
	return nil
}
