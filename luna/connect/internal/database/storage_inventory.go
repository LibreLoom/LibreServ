package database

import "database/sql"

type queryExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// LockStorageAccount excludes all storage writes while an operation removes blobs
// and their rows. Keep the transaction open through object deletion and SQL commit.
func LockStorageAccount(tx *Tx, accountID string) error {
	if tx.Driver() == DriverPostgres {
		var id string
		return tx.QueryRow(`SELECT id FROM accounts WHERE id = ? FOR UPDATE`, accountID).Scan(&id)
	}
	return lockStorageAccountSQLite(tx, accountID)
}

// LockStorageAccountWrite lets normal writes proceed together in PostgreSQL but
// keeps them out of an account purge. SQLite's single-writer lock provides the
// same exclusion for both helpers.
func LockStorageAccountWrite(tx *Tx, accountID string) error {
	if tx.Driver() == DriverPostgres {
		var id string
		return tx.QueryRow(`SELECT id FROM accounts WHERE id = ? FOR SHARE`, accountID).Scan(&id)
	}
	return lockStorageAccountSQLite(tx, accountID)
}

func lockStorageAccountSQLite(tx *Tx, accountID string) error {
	res, err := tx.Exec(`UPDATE accounts SET id = id WHERE id = ?`, accountID)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n != 1 {
		return sql.ErrNoRows
	}
	return nil
}

// LockStorageRecordInventory serializes a page read with record mutations for
// this Luna. The caller must keep the transaction open until it has read the
// version, count, and requested names. A no-op update takes the same database
// row lock as BumpStorageRecordVersion without changing the published version.
func LockStorageRecordInventory(exec queryExecer, accountID, lunaID string) error {
	if _, err := exec.Exec(`INSERT INTO storage_record_versions (account_id, luna_id, version)
VALUES (?, ?, 0)
ON CONFLICT(account_id, luna_id) DO NOTHING`, accountID, lunaID); err != nil {
		return err
	}
	_, err := exec.Exec(`UPDATE storage_record_versions SET version = version WHERE account_id = ? AND luna_id = ?`, accountID, lunaID)
	return err
}

// BumpStorageRecordVersion invalidates active paged listings whenever record names change.
func BumpStorageRecordVersion(exec queryExecer, accountID, lunaID string) error {
	_, err := exec.Exec(`INSERT INTO storage_record_versions (account_id, luna_id, version)
VALUES (?, ?, 1)
ON CONFLICT(account_id, luna_id) DO UPDATE SET version = storage_record_versions.version + 1`, accountID, lunaID)
	return err
}
