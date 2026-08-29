package database

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func Open(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && filepath.Dir(path) != "." {
		return nil, err
	}
	// WAL + busy timeout so two ZDU instances can share one file.
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	return db, nil
}

func Migrate(db *sql.DB) error {
	_, err := db.Exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_subscription_item_id TEXT,
  backup_quota_bytes INTEGER,
  has_card INTEGER NOT NULL DEFAULT 0,
  billing_status TEXT NOT NULL DEFAULT 'none',
  activated_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  subdomain TEXT NOT NULL UNIQUE,
  tunnel_id TEXT,
  tunnel_token TEXT,
  device_token TEXT,
  setup_secret TEXT,
  local_port INTEGER NOT NULL DEFAULT 8090,
  pairing_code TEXT,
  pairing_expires INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS backup_objects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_hash TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, device_id, relative_path)
);
CREATE TABLE IF NOT EXISTS register_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS issued_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  account_id TEXT,
  claimed_device_id TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  token_hint TEXT
);
CREATE TABLE IF NOT EXISTS setup_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guess_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  start INTEGER NOT NULL,
  last INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oss_payments (
  account_id TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(admin_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
);
`)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	// Existing files created before these columns; ignore duplicate-column errors.
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN device_token TEXT`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN setup_secret TEXT`)
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN stripe_subscription_item_id TEXT`)
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN backup_quota_bytes INTEGER`)
	_, _ = db.Exec(`ALTER TABLE issued_tokens ADD COLUMN token_hint TEXT`)
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN activated_at INTEGER`)
	return nil
}
