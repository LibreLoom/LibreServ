package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/Sol/internal/constants"
	_ "modernc.org/sqlite" // Pure Go SQLite driver
)

// DB wraps the SQLite connection and metadata.
type DB struct {
	db   *sql.DB
	path string

	// onReplace is called once the restored file is in place, before migration.
	// Services that cache rows from this DB use it to drop stale answers
	// immediately.
	onReplace func()
}

// SetOnReplace registers a hook for database restores. It is set once during
// startup, before any restore can run.
func (d *DB) SetOnReplace(fn func()) {
	d.onReplace = fn
}

// Open opens or creates the SQLite database at dbPath.
func Open(dbPath string) (*DB, error) {
	// Ensure directory exists
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0750); err != nil {
		return nil, fmt.Errorf("failed to create database directory: %w", err)
	}

	// Connect to database
	sqlDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Optimization: Enable Write-Ahead Logging (WAL) for concurrency and reliability
	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("failed to enable WAL mode: %w", err)
	}

	// Enable foreign key support
	if _, err := sqlDB.Exec("PRAGMA foreign_keys=ON"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("failed to enable foreign keys: %w", err)
	}

	// Set busy timeout to prevent locking errors (converted from milliseconds)
	busyTimeoutMs := int(constants.DatabaseBusyTimeout.Milliseconds())
	if _, err := sqlDB.Exec(fmt.Sprintf("PRAGMA busy_timeout=%d", busyTimeoutMs)); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("failed to set busy timeout: %w", err)
	}

	// PERFORMANCE TRADEOFF (audit finding #2, deliberate): a single open
	// connection serializes reads AND writes. WAL mode's usual benefit —
	// concurrent readers alongside one writer — is given up here to eliminate
	// SQLITE_BUSY errors from concurrent writers (jobqueue/scheduler vs HTTP
	// handlers) that modernc.org/sqlite surfaces even after busy_timeout.
	// Acceptable for this workload because queries are short and local; if
	// dashboard polling or backups ever stall behind writes, revisit with a
	// writer-isolation approach rather than simply raising MaxOpenConns.
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	// 0 = connections live forever; already the sql.DB default, kept explicit.
	sqlDB.SetConnMaxLifetime(0)

	return &DB{
		db:   sqlDB,
		path: dbPath,
	}, nil
}

// Path returns the database file path.
func (d *DB) Path() string {
	return d.path
}

// SQL returns the underlying *sql.DB for direct access.
func (d *DB) SQL() *sql.DB {
	return d.db
}

// Close closes the underlying database connection.
func (d *DB) Close() error {
	return d.db.Close()
}

// Ping checks database connectivity.
func (d *DB) Ping() error {
	return d.db.Ping()
}

// GetAdminUsers retrieves all users with admin role
func (d *DB) GetAdminUsers(ctx context.Context) ([]struct {
	ID       string
	Username string
	Email    string
}, error) {
	rows, err := d.db.QueryContext(ctx, `
		SELECT id, username, email 
		FROM users 
		WHERE role = 'admin' AND email IS NOT NULL AND email != ''
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var admins []struct {
		ID       string
		Username string
		Email    string
	}

	for rows.Next() {
		var admin struct {
			ID       string
			Username string
			Email    string
		}
		if err := rows.Scan(&admin.ID, &admin.Username, &admin.Email); err != nil {
			return nil, err
		}
		admins = append(admins, admin)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return admins, nil
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

	// Check the replacement before the swap, on its own handle with the
	// caller's context and a short budget, so the page walk does not consume
	// the restore request's whole write timeout alongside the migration.
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	corrupt, err := integrityCheckFile(checkCtx, replacementPath)
	cancel()
	if err != nil {
		return err
	}
	if corrupt {
		return errors.New("restored database failed its integrity check")
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
	if d.onReplace != nil {
		d.onReplace()
	}

	// Ensure schema is compatible with current binary.
	if err := d.Migrate(); err != nil {
		return err
	}

	// Clean up the rollback safety net on success.
	if rollbackPath != "" {
		if err := os.Remove(rollbackPath); err != nil && !os.IsNotExist(err) {
			slog.Warn("failed to remove pre-restore rollback file", "path", rollbackPath, "error", err)
		}
	}
	return nil
}

// HealthCheck is a cheap liveness probe. It runs on every health endpoint hit
// and on the dashboard's monitoring poll, so it must not walk every page.
// It stats the file and reads the schema through the already-open pool, which
// catches a deleted or unreadable database but not page-level corruption; that
// needs IntegrityCheck.
func (d *DB) HealthCheck() error {
	// The open handle can keep serving from an unlinked file. A stat on every
	// probe is cheap and makes /health/ready stop lying when the file is gone.
	if d.path != ":memory:" {
		if _, err := os.Stat(d.path); err != nil {
			// These errors travel through public health endpoints. Log the
			// path here; callers only get the sentinel.
			slog.Warn("database file stat failed", "path", d.path, "error", err)
			if errors.Is(err, fs.ErrNotExist) {
				return ErrDatabaseFileMissing
			}
			return ErrDatabaseUnreadable
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var count int
	if err := d.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master").Scan(&count); err != nil {
		return fmt.Errorf("database health check failed: %w", err)
	}
	return nil
}

// IntegrityCheck walks every page of the database. It is intentionally not
// part of HealthCheck: probes hit that on a short interval and a full scan on
// every request added disk IO proportional to database size. The bool reports
// corruption found by a completed check; an error means the check could not
// run, which is a different thing to tell an admin.
func (d *DB) IntegrityCheck() (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return d.IntegrityCheckContext(ctx)
}

func (d *DB) IntegrityCheckContext(ctx context.Context) (bool, error) {
	// A new handle to an in-memory path would be a different, empty database.
	// Use the real pool for that rare case; the page walk is serialized there.
	if d.path == ":memory:" {
		return integrityCheckOn(ctx, d.db)
	}
	// The main pool has a single connection. A page walk on it would block
	// every other query and make the 2 s health probe report the database as
	// unhealthy, so diagnostics on a real file use their own handle.
	return integrityCheckFile(ctx, d.path)
}

func integrityCheckFile(ctx context.Context, path string) (bool, error) {
	// mode=rw never creates a file; the stat below also gives a clear error
	// when the database has been deleted or unmounted. Plain sql.Open would
	// create a fresh empty database that passes integrity_check.
	if _, err := os.Stat(path); err != nil {
		return false, fmt.Errorf("database integrity check failed: %w", err)
	}
	dsn := "file:" + url.PathEscape(path) + "?mode=rw"
	tmp, err := sql.Open("sqlite", dsn)
	if err != nil {
		return false, fmt.Errorf("database integrity check failed: %w", err)
	}
	defer tmp.Close()
	tmp.SetMaxOpenConns(1)
	_, _ = tmp.ExecContext(ctx, "PRAGMA busy_timeout=5000")
	return integrityCheckOn(ctx, tmp)
}

// ErrDatabaseCorrupt marks a file that SQLite says is damaged or is not a
// database at all. Retrying such a check never helps; the admin needs to
// restore a backup.
var (
	ErrDatabaseCorrupt = errors.New("database file is corrupt")
	// ErrDatabaseFileMissing is returned by the cheap probe when the file has
	// been deleted or unmounted; handlers keep the path out of public responses.
	ErrDatabaseFileMissing = errors.New("database file is missing")
	// ErrDatabaseUnreadable covers permissions and IO errors; restoring a
	// backup is not the right next step for those.
	ErrDatabaseUnreadable = errors.New("database file is unreadable")
)

func integrityQueryError(err error) error {
	if err == nil {
		return nil
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "not a database") ||
		strings.Contains(message, "malformed") ||
		strings.Contains(message, "database image") ||
		strings.Contains(message, "file is encrypted") {
		return fmt.Errorf("%w: %v", ErrDatabaseCorrupt, err)
	}
	return fmt.Errorf("database integrity check failed: %w", err)
}

func integrityCheckOn(ctx context.Context, conn *sql.DB) (bool, error) {
	var count int
	if err := conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master").Scan(&count); err != nil {
		return false, integrityQueryError(err)
	}

	var integrityOk string
	if err := conn.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrityOk); err != nil {
		return false, integrityQueryError(err)
	}
	return integrityOk != "ok", nil
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

// CleanupStaleBackups removes stale pre-restore and pre-migration backup files
// that may have been left behind from previous interrupted operations.
func (d *DB) CleanupStaleBackups() error {
	if d.path == "" {
		return nil
	}

	dir := filepath.Dir(d.path)
	base := filepath.Base(d.path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("failed to read backup directory: %w", err)
	}

	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, base+".pre-restore-") ||
			strings.HasPrefix(name, base+".pre-migration-") {
			path := filepath.Join(dir, name)
			slog.Info("Cleaning up stale safety-net file", "path", path)
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				slog.Warn("failed to remove stale file", "path", path, "error", err)
			}
		}
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

// ExecContext executes a query with context without returning rows
func (d *DB) ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	return d.db.ExecContext(ctx, query, args...)
}

// QueryRowContext executes a query with context that is expected to return at most one row
func (d *DB) QueryRowContext(ctx context.Context, query string, args ...interface{}) *sql.Row {
	return d.db.QueryRowContext(ctx, query, args...)
}

// QueryContext executes a query with context that returns rows
func (d *DB) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	return d.db.QueryContext(ctx, query, args...)
}
