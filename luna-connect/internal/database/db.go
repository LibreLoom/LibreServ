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
  email_verified INTEGER NOT NULL DEFAULT 0,
  backup_purge_after INTEGER,
  purge_mail_day INTEGER,
  onboarding_path TEXT,
  onboarding_step TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verif_account ON email_verification_tokens(account_id);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT,
  code_sealed TEXT,
  kind TEXT NOT NULL DEFAULT 'official',
  account_id TEXT,
  name TEXT,
  subdomain TEXT UNIQUE,
  tunnel_id TEXT,
  tunnel_token TEXT,
  setup_secret TEXT,
  local_port INTEGER NOT NULL DEFAULT 8090,
  last_seen_at INTEGER,
  order_ref TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
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
  storage_backend TEXT NOT NULL DEFAULT 'local',
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, device_id, relative_path)
);
CREATE TABLE IF NOT EXISTS backup_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at INTEGER,
  archive_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, device_id)
);
CREATE TABLE IF NOT EXISTS register_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  start INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS service_providers (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  credentials_json TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(service, name)
);
CREATE TABLE IF NOT EXISTS device_backup_buckets (
  device_id TEXT PRIMARY KEY,
  bucket_name TEXT NOT NULL UNIQUE,
  bucket_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  key_id TEXT NOT NULL,
  application_key_sealed TEXT NOT NULL,
  provisioned_at INTEGER NOT NULL,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS billing_storage_samples (
  account_id TEXT NOT NULL,
  period_ym TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  PRIMARY KEY (account_id, sampled_at)
);
CREATE INDEX IF NOT EXISTS idx_billing_storage_period ON billing_storage_samples (account_id, period_ym);
CREATE TABLE IF NOT EXISTS billing_period_egress (
  account_id TEXT NOT NULL,
  period_ym TEXT NOT NULL,
  egress_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, period_ym)
);
`)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	// Additive columns for older DBs / forward-compatible fields.
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN stripe_subscription_item_id TEXT`)
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN backup_quota_bytes INTEGER`)
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`)
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN backup_purge_after INTEGER`)
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN purge_mail_day INTEGER`)
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN onboarding_path TEXT`)
	_, _ = db.Exec(`ALTER TABLE accounts ADD COLUMN onboarding_step TEXT`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN code_hash TEXT`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN code_hint TEXT`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN code_sealed TEXT`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'official'`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN setup_secret TEXT`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN last_seen_at INTEGER`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN order_ref TEXT`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0`)
	_, _ = db.Exec(`ALTER TABLE devices ADD COLUMN tunnel_token TEXT`)
	_, _ = db.Exec(`ALTER TABLE backup_objects ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'local'`)

	// Legacy devices required token_hash + subdomain on every row. Permanent
	// unbound codes only set code_hash and leave subdomain NULL, so upgraded
	// DBs must rebuild devices (SQLite cannot drop NOT NULL via ALTER).
	if err := upgradeDevicesTable(db); err != nil {
		return err
	}
	return nil
}

type columnInfo struct {
	name    string
	notNull bool
}

func tableColumns(db *sql.DB, table string) (map[string]columnInfo, error) {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]columnInfo{}
	for rows.Next() {
		var cid, notNull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk); err != nil {
			return nil, err
		}
		out[name] = columnInfo{name: name, notNull: notNull == 1}
	}
	return out, rows.Err()
}

func upgradeDevicesTable(db *sql.DB) error {
	cols, err := tableColumns(db, "devices")
	if err != nil {
		return fmt.Errorf("devices pragma: %w", err)
	}
	if len(cols) == 0 {
		return nil
	}

	_, hasTokenHash := cols["token_hash"]
	sub, hasSubdomain := cols["subdomain"]
	needsRebuild := hasTokenHash || (hasSubdomain && sub.notNull)
	if !needsRebuild {
		return nil
	}

	// SQLite ignores foreign_keys changes inside an open transaction — flip
	// the connection flag first, then rebuild.
	if _, err := db.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		return err
	}
	defer func() { _, _ = db.Exec(`PRAGMA foreign_keys=ON`) }()

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// Backfill before copy so unbound-mint inserts and old rows both work.
	if hasTokenHash {
		if _, err := tx.Exec(`UPDATE devices SET code_hash = token_hash WHERE (code_hash IS NULL OR code_hash = '') AND token_hash IS NOT NULL AND token_hash != ''`); err != nil {
			return fmt.Errorf("backfill code_hash: %w", err)
		}
	}

	if _, err := tx.Exec(`
CREATE TABLE devices_new (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT,
  code_sealed TEXT,
  kind TEXT NOT NULL DEFAULT 'official',
  account_id TEXT,
  name TEXT,
  subdomain TEXT UNIQUE,
  tunnel_id TEXT,
  tunnel_token TEXT,
  setup_secret TEXT,
  local_port INTEGER NOT NULL DEFAULT 8090,
  last_seen_at INTEGER,
  order_ref TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
)`); err != nil {
		return fmt.Errorf("create devices_new: %w", err)
	}

	// Prefer already-migrated columns; fall back to legacy names.
	codeHashExpr := "code_hash"
	if hasTokenHash {
		codeHashExpr = "COALESCE(NULLIF(code_hash, ''), token_hash)"
	}
	tunnelTokenExpr := "NULL"
	if _, ok := cols["tunnel_token"]; ok {
		tunnelTokenExpr = "tunnel_token"
	}
	setupSecretExpr := "NULL"
	if _, ok := cols["setup_secret"]; ok {
		setupSecretExpr = "setup_secret"
	}
	kindExpr := "'official'"
	if _, ok := cols["kind"]; ok {
		kindExpr = "COALESCE(NULLIF(kind, ''), 'official')"
	}
	codeHintExpr := "NULL"
	if _, ok := cols["code_hint"]; ok {
		codeHintExpr = "code_hint"
	}
	codeSealedExpr := "NULL"
	if _, ok := cols["code_sealed"]; ok {
		codeSealedExpr = "code_sealed"
	}
	lastSeenExpr := "NULL"
	if _, ok := cols["last_seen_at"]; ok {
		lastSeenExpr = "last_seen_at"
	}
	orderRefExpr := "NULL"
	if _, ok := cols["order_ref"]; ok {
		orderRefExpr = "order_ref"
	}
	revokedExpr := "0"
	if _, ok := cols["revoked"]; ok {
		revokedExpr = "COALESCE(revoked, 0)"
	}
	localPortExpr := "8090"
	if _, ok := cols["local_port"]; ok {
		localPortExpr = "COALESCE(local_port, 8090)"
	}
	nameExpr := "NULL"
	if _, ok := cols["name"]; ok {
		nameExpr = "name"
	}
	accountExpr := "NULL"
	if _, ok := cols["account_id"]; ok {
		accountExpr = "account_id"
	}
	subdomainExpr := "NULL"
	if hasSubdomain {
		subdomainExpr = "NULLIF(subdomain, '')"
	}
	tunnelIDExpr := "NULL"
	if _, ok := cols["tunnel_id"]; ok {
		tunnelIDExpr = "tunnel_id"
	}

	copySQL := fmt.Sprintf(`
INSERT INTO devices_new (
  id, code_hash, code_hint, code_sealed, kind, account_id, name, subdomain,
  tunnel_id, tunnel_token, setup_secret, local_port, last_seen_at, order_ref, revoked, created_at
)
SELECT
  id,
  %s,
  %s,
  %s,
  %s,
  %s,
  %s,
  %s,
  %s,
  %s,
  %s,
  %s,
  %s,
  %s,
  %s,
  created_at
FROM devices
WHERE %s IS NOT NULL AND %s != ''`,
		codeHashExpr, codeHintExpr, codeSealedExpr, kindExpr, accountExpr, nameExpr, subdomainExpr,
		tunnelIDExpr, tunnelTokenExpr, setupSecretExpr, localPortExpr, lastSeenExpr, orderRefExpr, revokedExpr,
		codeHashExpr, codeHashExpr,
	)
	if _, err := tx.Exec(copySQL); err != nil {
		return fmt.Errorf("copy devices: %w", err)
	}

	if _, err := tx.Exec(`DROP TABLE devices`); err != nil {
		return fmt.Errorf("drop devices: %w", err)
	}
	if _, err := tx.Exec(`ALTER TABLE devices_new RENAME TO devices`); err != nil {
		return fmt.Errorf("rename devices_new: %w", err)
	}
	return tx.Commit()
}
