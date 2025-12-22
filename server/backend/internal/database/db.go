package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
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

func (d *DB) Path() string {
	return d.path
}

func (d *DB) Close() error {
	return d.db.Close()
}

func (d *DB) Ping() error {
	return d.db.Ping()
}

// ReplaceFile atomically swaps the underlying SQLite database file with the provided replacement file.
//
// Requirements/assumptions:
// - replacementPath must be on the same filesystem as d.Path() for atomic rename (best effort).
// - This closes and reopens the DB connection; callers should treat this as a maintenance operation.
func (d *DB) ReplaceFile(ctx context.Context, replacementPath string) error {
	if d == nil {
		return errors.New("db is nil")
	}
	if replacementPath == "" {
		return errors.New("replacement path is empty")
	}
	if _, err := os.Stat(replacementPath); err != nil {
		return fmt.Errorf("replacement file not accessible: %w", err)
	}

	targetPath := d.path
	if targetPath == "" {
		return errors.New("db target path is empty")
	}

	// Close the current DB handle first to release file locks.
	if d.db != nil {
		_ = d.db.Close()
	}

	// Remove WAL/SHM sidecars (best effort) so we don't accidentally mix restored main DB with old WAL state.
	_ = os.Remove(targetPath + "-wal")
	_ = os.Remove(targetPath + "-shm")

	// Move the current DB file out of the way (rollback target).
	rollbackPath := ""
	if _, err := os.Stat(targetPath); err == nil {
		rollbackPath = fmt.Sprintf("%s.pre-restore-%s", targetPath, time.Now().Format("20060102-150405"))
		if err := os.Rename(targetPath, rollbackPath); err != nil {
			return fmt.Errorf("failed to move current db for rollback: %w", err)
		}
	}

	// Place replacement at target path.
	if err := os.Rename(replacementPath, targetPath); err != nil {
		// Roll back if we moved the original.
		if rollbackPath != "" {
			_ = os.Rename(rollbackPath, targetPath)
		}
		return fmt.Errorf("failed to replace db file: %w", err)
	}

	// Re-open DB (and reapply pragmas).
	newDB, err := Open(targetPath)
	if err != nil {
		// Restore rollback DB if possible.
		if rollbackPath != "" {
			_ = os.Remove(targetPath)
			_ = os.Rename(rollbackPath, targetPath)
			if rb, rbErr := Open(targetPath); rbErr == nil {
				d.db = rb.db
			}
		}
		return fmt.Errorf("failed to reopen database after restore: %w", err)
	}
	d.db = newDB.db

	// Ensure schema is compatible with current binary and verify integrity.
	if err := d.Migrate(); err != nil {
		return err
	}
	if err := d.HealthCheck(); err != nil {
		return err
	}

	// If everything succeeded, we can optionally keep rollbackPath as a safety net.
	_ = ctx // reserved for future timeouts/cancellation during restore pipeline
	return nil
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

// CopyFile is a helper to copy a file from src to dst.
func CopyFile(src, dst string) error {
	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()

	destination, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destination.Close()

	_, err = io.Copy(destination, source)
	return err
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
