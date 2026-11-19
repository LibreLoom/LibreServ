package database

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// Open opens SQLite at path (dev/tests default).
func Open(path string) (*DB, error) {
	return openSQLite(path)
}

// OpenFromConfig selects sqlite or postgres from config fields.
func OpenFromConfig(driver, path, url string) (*DB, error) {
	switch strings.ToLower(strings.TrimSpace(driver)) {
	case "", "sqlite":
		if path == "" {
			path = "dev/luna-connect.db"
		}
		return openSQLite(path)
	case "postgres", "postgresql":
		if strings.TrimSpace(url) == "" {
			return nil, fmt.Errorf("database.url is required when database.driver=postgres")
		}
		return openPostgres(url)
	default:
		return nil, fmt.Errorf("unsupported database driver %q (use sqlite or postgres)", driver)
	}
}

func openSQLite(path string) (*DB, error) {
	dir := filepath.Dir(path)
	if dir != "." {
		// The database holds customer emails, password hashes and session
		// hashes. Keep its directory private to the service user.
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	// sql.Open creates the database lazily with the process umask (0644 on the
	// shipped unit), so create it ourselves owner-only and tighten a file that
	// an older install already left readable.
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	tightenSQLiteFile(path)
	tightenSQLiteFile(path + "-wal")
	tightenSQLiteFile(path + "-shm")

	// WAL + busy timeout so two ZDU instances can share one file.
	inner, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	inner.SetMaxOpenConns(8)
	inner.SetMaxIdleConns(4)
	return &DB{DB: inner, driver: DriverSQLite}, nil
}

// tightenSQLiteFile makes a database file owner-only. Best effort: an existing
// deployment whose files belong to another user still opens, with its mode left
// as it was.
func tightenSQLiteFile(path string) {
	_ = os.Chmod(path, 0o600)
}

func openPostgres(url string) (*DB, error) {
	inner, err := sql.Open("pgx", url)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	inner.SetMaxOpenConns(25)
	inner.SetMaxIdleConns(5)
	if err := inner.Ping(); err != nil {
		_ = inner.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &DB{DB: inner, driver: DriverPostgres}, nil
}
