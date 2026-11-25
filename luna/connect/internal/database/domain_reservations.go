package database

import (
	"database/sql"
	"errors"
)

// ErrDomainReserved reports that another live device already owns the hostname.
var ErrDomainReserved = errors.New("domain reserved by another device")

// ReserveDomain serializes DNS/tunnel mutation for a hostname. The reservation
// row lives in the same transaction as the device's final subdomain update.
// Stale rows are removed when their device no longer maps to the hostname.
func ReserveDomain(tx *Tx, hostname, subdomain, deviceID, accountID string, now int64) error {
	for attempt := 0; attempt < 2; attempt++ {
		if err := insertDomainReservation(tx, hostname, deviceID, accountID, now); err != nil {
			return err
		}
		if err := lockDomainReservation(tx, hostname); err != nil {
			return err
		}
		var ownerDevice, ownerAccount string
		if err := tx.QueryRow(`SELECT device_id, account_id FROM domain_reservations WHERE hostname = ?`, hostname).
			Scan(&ownerDevice, &ownerAccount); err != nil {
			return err
		}
		if ownerDevice == deviceID && ownerAccount == accountID {
			return nil
		}
		stale, err := domainReservationStale(tx, hostname, subdomain, ownerDevice, ownerAccount)
		if err != nil {
			return err
		}
		if !stale {
			return ErrDomainReserved
		}
		if _, err := tx.Exec(`DELETE FROM domain_reservations WHERE hostname = ? AND device_id = ?`, hostname, ownerDevice); err != nil {
			return err
		}
	}
	return ErrDomainReserved
}

func insertDomainReservation(tx *Tx, hostname, deviceID, accountID string, now int64) error {
	if tx.Driver() == DriverPostgres {
		_, err := tx.Exec(`INSERT INTO domain_reservations (hostname, device_id, account_id, created_at)
			VALUES (?, ?, ?, ?) ON CONFLICT (hostname) DO NOTHING`, hostname, deviceID, accountID, now)
		return err
	}
	_, err := tx.Exec(`INSERT OR IGNORE INTO domain_reservations (hostname, device_id, account_id, created_at)
		VALUES (?, ?, ?, ?)`, hostname, deviceID, accountID, now)
	return err
}

func lockDomainReservation(tx *Tx, hostname string) error {
	if tx.Driver() == DriverPostgres {
		var name string
		err := tx.QueryRow(`SELECT hostname FROM domain_reservations WHERE hostname = ? FOR UPDATE`, hostname).Scan(&name)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrDomainReserved
		}
		return err
	}
	_, err := tx.Exec(`UPDATE domain_reservations SET hostname = hostname WHERE hostname = ?`, hostname)
	return err
}

func domainReservationStale(tx *Tx, hostname, subdomain, deviceID, accountID string) (bool, error) {
	var currentSub, currentState, currentAccount sql.NullString
	err := tx.QueryRow(`SELECT COALESCE(subdomain,''), COALESCE(state,''), COALESCE(account_id,'')
		FROM devices WHERE id = ?`, deviceID).Scan(&currentSub, &currentState, &currentAccount)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return currentSub.String != subdomain || currentState.String != "bound" || currentAccount.String != accountID, nil
}

// LockDomainReservation serializes teardown with provisioning for a hostname.
// A missing reservation is fine: there is nothing to fence.
func LockDomainReservation(tx *Tx, hostname string) error {
	if tx.Driver() == DriverPostgres {
		var name string
		err := tx.QueryRow(`SELECT hostname FROM domain_reservations WHERE hostname = ? FOR UPDATE`, hostname).Scan(&name)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	_, err := tx.Exec(`UPDATE domain_reservations SET hostname = hostname WHERE hostname = ?`, hostname)
	return err
}

// ReleaseDomain removes only the reservation owned by deviceID.
func ReleaseDomain(tx *Tx, hostname, deviceID string) error {
	_, err := tx.Exec(`DELETE FROM domain_reservations WHERE hostname = ? AND device_id = ?`, hostname, deviceID)
	return err
}
