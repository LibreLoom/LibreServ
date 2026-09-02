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
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && filepath.Dir(path) != "." {
		return nil, err
	}
	// WAL + busy timeout so two ZDU instances can share one file.
	inner, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	inner.SetMaxOpenConns(8)
	inner.SetMaxIdleConns(4)
	return &DB{DB: inner, driver: DriverSQLite}, nil
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
