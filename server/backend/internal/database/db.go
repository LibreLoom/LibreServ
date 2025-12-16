package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // Pure Go SQLite driver
)

type DB struct {
	db   *sql.DB
	path string
}

func Open(dbPath string) (*DB, error) {
	// Ensure directory exists
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create database directory: %w", err)
	}

	// Connect to database
	sqlDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Optimization: Enable Write-Ahead Logging (WAL) for concurrency and reliability
	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL"); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("failed to enable WAL mode: %w", err)
	}

	// Enable foreign key support
	if _, err := sqlDB.Exec("PRAGMA foreign_keys=ON"); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("failed to enable foreign keys: %w", err)
	}

	// Set busy timeout to prevent locking errors
	if _, err := sqlDB.Exec("PRAGMA busy_timeout=5000"); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("failed to set busy timeout: %w", err)
	}

	return &DB{
		db:   sqlDB,
		path: dbPath,
	}, nil
}

func (d *DB) Close() error {
	return d.db.Close()
}

func (d *DB) Ping() error {
	return d.db.Ping()
}

// HealthCheck performs a quick self-diagnostic
func (d *DB) HealthCheck() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var count int
	err := d.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master").Scan(&count)
	if err != nil {
		return fmt.Errorf("database health check failed: %w", err)
	}

	var integrityOk string
	err = d.db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrityOk)
	if err != nil || integrityOk != "ok" {
		return fmt.Errorf("database integrity check failed (result: %s): %v", integrityOk, err)
	}

	return nil
}

// Exec executes a query without returning rows
func (d *DB) Exec(query string, args ...interface{}) (sql.Result, error) {
	return d.db.Exec(query, args...)
}

// QueryRow executes a query that is expected to return at most one row
func (d *DB) QueryRow(query string, args ...interface{}) *sql.Row {
	return d.db.QueryRow(query, args...)
}

// Query executes a query that returns rows
func (d *DB) Query(query string, args ...interface{}) (*sql.Rows, error) {
	return d.db.Query(query, args...)
}
