package database

import (
	"database/sql"
	"fmt"
	_ "github.com/jackc/pgx/v5/stdlib"
	"math/rand/v2"
	"os"
	"strings"
	"testing"
)

// OpenTestDB creates a fresh Postgres database for testing.
//
// It uses CONNECT_TEST_DATABASE_URL to connect to a Postgres instance with
// create-database privileges. A unique test database is created per test,
// migrated, and dropped on cleanup.
//
// If CONNECT_TEST_DATABASE_URL is not set, tests are skipped — they require
// a running Postgres instance.
//
// Example: CONNECT_TEST_DATABASE_URL=postgres://localhost:5432/template1?sslmode=disable
func OpenTestDB(t *testing.T) *sql.DB {
	t.Helper()

	baseURL := os.Getenv("CONNECT_TEST_DATABASE_URL")
	if baseURL == "" {
		t.Skip("CONNECT_TEST_DATABASE_URL not set — skipping database test")
	}

	// Connect to the server (not a specific DB) to create a test DB.
	adminDB, err := sql.Open("pgx", baseURL)
	if err != nil {
		t.Fatalf("open admin db: %v", err)
	}
	testDBName := fmt.Sprintf("connect_test_%d", rand.IntN(1000000))

	if _, err := adminDB.Exec(fmt.Sprintf("CREATE DATABASE %s", testDBName)); err != nil {
		adminDB.Close()
		t.Fatalf("create test db: %v", err)
	}
	adminDB.Close()

	// Build the DSN for the new test database.
	testURL := replaceDatabaseName(baseURL, testDBName)

	db, err := sql.Open("pgx", testURL)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}

	if err := Migrate(db); err != nil {
		db.Close()
		adminDB.Exec(fmt.Sprintf("DROP DATABASE IF EXISTS %s", testDBName))
		t.Fatalf("migrate test db: %v", err)
	}

	t.Cleanup(func() {
		db.Close()
		// Reconnect to admin DB to drop the test database.
		dropDB, err := sql.Open("pgx", baseURL)
		if err != nil {
			t.Errorf("open admin db for cleanup: %v", err)
			return
		}
		defer dropDB.Close()
		dropDB.Exec(fmt.Sprintf("DROP DATABASE IF EXISTS %s", testDBName))
	})

	return db
}

// replaceDatabaseName swaps the database name in a Postgres connection URL.
// Handles: postgres://host:port/dbname?params and postgres://host:port/dbname
func replaceDatabaseName(dsn, dbName string) string {
	// Find the path after the host:port (the last '/' after '://').
	schemeEnd := strings.Index(dsn, "://")
	if schemeEnd < 0 {
		return dsn
	}
	rest := dsn[schemeEnd+3:]
	pathStart := strings.LastIndex(rest, "/")
	if pathStart < 0 {
		// No path — just append the dbname.
		return dsn + "/" + dbName
	}
	absPathStart := schemeEnd + 3 + pathStart
	queryStart := strings.Index(dsn[absPathStart:], "?")
	if queryStart < 0 {
		return dsn[:absPathStart+1] + dbName
	}
	return dsn[:absPathStart+1] + dbName + dsn[absPathStart+queryStart:]
}
