package database

import (
	"database/sql"
	"fmt"
)

func Migrate(db *DB) error {
	if db == nil {
		return fmt.Errorf("migrate: nil db")
	}
	switch db.driver {
	case DriverPostgres:
		if _, err := db.Exec(schemaPostgres); err != nil {
			return fmt.Errorf("migrate postgres schema: %w", err)
		}
		return applyAdditiveColumnsPostgres(db)
	default:
		if _, err := db.Exec(schemaSQLite); err != nil {
			return fmt.Errorf("migrate sqlite schema: %w", err)
		}
		return applyAdditiveColumnsSQLite(db)
	}
}

func applyAdditiveColumnsSQLite(db *DB) error {
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

func applyAdditiveColumnsPostgres(db *DB) error {
	cols := []string{
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stripe_subscription_item_id TEXT`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS backup_quota_bytes BIGINT`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS backup_purge_after BIGINT`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS purge_mail_day INTEGER`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS onboarding_path TEXT`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS onboarding_step TEXT`,
		`ALTER TABLE devices ADD COLUMN IF NOT EXISTS code_hash TEXT`,
		`ALTER TABLE devices ADD COLUMN IF NOT EXISTS code_hint TEXT`,
		`ALTER TABLE devices ADD COLUMN IF NOT EXISTS code_sealed TEXT`,
		`ALTER TABLE devices ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'official'`,
		`ALTER TABLE devices ADD COLUMN IF NOT EXISTS setup_secret TEXT`,
		`ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen_at BIGINT`,
		`ALTER TABLE devices ADD COLUMN IF NOT EXISTS order_ref TEXT`,
		`ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE devices ADD COLUMN IF NOT EXISTS tunnel_token TEXT`,
		`ALTER TABLE backup_objects ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'local'`,
	}
	for _, q := range cols {
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("postgres additive migrate: %w", err)
		}
	}
	return nil
}

type columnInfo struct {
	name    string
	notNull bool
}

func tableColumns(db *DB, table string) (map[string]columnInfo, error) {
	if db.driver == DriverPostgres {
		return tableColumnsPostgres(db, table)
	}
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

func tableColumnsPostgres(db *DB, table string) (map[string]columnInfo, error) {
	rows, err := db.Query(`
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = CURRENT_SCHEMA() AND table_name = ?`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]columnInfo{}
	for rows.Next() {
		var name, nullable string
		if err := rows.Scan(&name, &nullable); err != nil {
			return nil, err
		}
		out[name] = columnInfo{name: name, notNull: nullable == "NO"}
	}
	return out, rows.Err()
}

func upgradeDevicesTable(db *DB) error {
	if db.driver != DriverSQLite {
		return nil
	}
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
