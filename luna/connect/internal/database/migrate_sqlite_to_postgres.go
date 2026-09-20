package database

import (
	"database/sql"
	"fmt"
	"strings"
)

// MigrateSQLiteToPostgres copies all Luna Connect tables from src (SQLite) into dst (Postgres).
func MigrateSQLiteToPostgres(src, dst *DB) error {
	if src == nil || dst == nil {
		return fmt.Errorf("migrate: nil database")
	}
	if src.Driver() != DriverSQLite {
		return fmt.Errorf("migrate: source must be sqlite")
	}
	if dst.Driver() != DriverPostgres {
		return fmt.Errorf("migrate: destination must be postgres")
	}
	if err := Migrate(dst); err != nil {
		return err
	}
	tx, err := dst.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, table := range migrateTables {
		n, err := copyTableSQLiteToPostgres(src.DB, tx, table)
		if err != nil {
			return fmt.Errorf("%s: %w", table, err)
		}
		_ = n
	}
	return tx.Commit()
}

func copyTableSQLiteToPostgres(src *sql.DB, dst *Tx, table string) (int, error) {
	cols, err := sqliteTableColumns(src, table)
	if err != nil {
		return 0, err
	}
	if len(cols) == 0 {
		return 0, nil
	}
	if _, err := dst.Exec(`DELETE FROM ` + table); err != nil {
		return 0, err
	}
	colList := strings.Join(cols, ", ")
	placeholders := make([]string, len(cols))
	for i := range cols {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}
	insertSQL := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, colList, strings.Join(placeholders, ", "))

	rows, err := src.Query(`SELECT ` + colList + ` FROM ` + table)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return count, err
		}
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}
		if _, err := dst.Exec(insertSQL, values...); err != nil {
			return count, fmt.Errorf("insert row %d: %w", count+1, err)
		}
		count++
	}
	return count, rows.Err()
}
