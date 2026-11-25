package database

import "database/sql"

// LockDevice serializes pairing, token rotation, and revocation for one Luna.
// The SQLite no-op update takes the same write lock as the later state change.
func LockDevice(tx *Tx, deviceID string) error {
	if tx.Driver() == DriverPostgres {
		var id string
		return tx.QueryRow(`SELECT id FROM devices WHERE id = ? FOR UPDATE`, deviceID).Scan(&id)
	}
	res, err := tx.Exec(`UPDATE devices SET id = id WHERE id = ?`, deviceID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return sql.ErrNoRows
	}
	return nil
}
