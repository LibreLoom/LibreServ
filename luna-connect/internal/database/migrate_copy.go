package database

import (
	"database/sql"
	"fmt"
	"strings"
)

// copyTablesForTest copies migrateTables from src to dst (used by migration tool tests).
func copyTablesForTest(src, dst *sql.DB) error {
	tx, err := dst.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, table := range migrateTables {
		if _, err := copyTableRaw(src, tx, table); err != nil {
			return fmt.Errorf("%s: %w", table, err)
		}
	}
	return tx.Commit()
}

var migrateTables = []string{
	"accounts",
	"email_verification_tokens",
	"devices",
	"sessions",
	"backup_objects",
	"backup_bindings",
	"register_attempts",
	"guess_attempts",
	"oss_payments",
	"admin_accounts",
	"admin_sessions",
	"service_providers",
	"device_backup_buckets",
	"billing_storage_samples",
	"billing_period_egress",
}

func copyTableRaw(src *sql.DB, dst *sql.Tx, table string) (int, error) {
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
	placeholders := strings.Repeat("?,", len(cols))
	placeholders = placeholders[:len(placeholders)-1]
	insertSQL := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, colList, placeholders)

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
			return count, err
		}
		count++
	}
	return count, rows.Err()
}

func sqliteTableColumns(db *sql.DB, table string) ([]string, error) {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var cid, notNull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols = append(cols, name)
	}
	return cols, rows.Err()
}
