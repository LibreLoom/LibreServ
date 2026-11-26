package database

import (
	"database/sql"
	"errors"
)

// ErrDomainReserved reports that another live device already owns the hostname.
var ErrDomainReserved = errors.New("domain reserved by another device")

// ReserveDomain serializes DNS/tunnel mutation for a hostname. The reservation
// row lives in the same transaction as the device's final subdomain update.
// Callers must lock the device first and acquire multiple hostnames in sorted
// order.
func ReserveDomain(tx *Tx, hostname, subdomain, deviceID, accountID string, now int64) error {
	for attempt := 0; attempt < 2; attempt++ {
		if err := insertDomainReservation(tx, hostname, deviceID, accountID, now); err != nil {
			return err
		}
		if err := lockDomainReservation(tx, hostname); err != nil {
			return err
		}
		var reservationDevice, reservationAccount string
		if err := tx.QueryRow(`SELECT device_id, account_id FROM domain_reservations WHERE hostname = ?`, hostname).
			Scan(&reservationDevice, &reservationAccount); err != nil {
			return err
		}

		// The devices row is authoritative for databases created before
		// reservations existed. Check it only after taking the reservation lock so
		// legacy-owner teardown and a new provisioning request still serialize on
		// the same row on PostgreSQL.
		ownerDevice, ownerAccount, assigned, err := assignedDomainDevice(tx, subdomain)
		if err != nil {
			return err
		}
		if assigned && (ownerDevice != deviceID || ownerAccount != accountID) {
			return ErrDomainReserved
		}
		if reservationDevice == deviceID && reservationAccount == accountID {
			return nil
		}
		stale, err := domainReservationStale(tx, subdomain, reservationDevice, reservationAccount)
		if err != nil {
			return err
		}
		if !stale {
			return ErrDomainReserved
		}
		if _, err := tx.Exec(`DELETE FROM domain_reservations
			WHERE hostname = ? AND device_id = ? AND account_id = ?`,
			hostname, reservationDevice, reservationAccount); err != nil {
			return err
		}
	}
	return ErrDomainReserved
}

func assignedDomainDevice(tx *Tx, subdomain string) (deviceID, accountID string, found bool, err error) {
	var account sql.NullString
	err = tx.QueryRow(`SELECT id, account_id FROM devices WHERE subdomain = ?`, subdomain).
		Scan(&deviceID, &account)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return deviceID, account.String, true, nil
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
	res, err := tx.Exec(`UPDATE domain_reservations SET hostname = hostname WHERE hostname = ?`, hostname)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrDomainReserved
	}
	return nil
}

func domainReservationStale(tx *Tx, subdomain, deviceID, accountID string) (bool, error) {
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

// OwnsDomainReservation reports whether deviceID still owns the fenced hostname.
// Cleanup uses it before touching DNS so a failed operation can never remove a
// record that has meanwhile been assigned to another device.
func OwnsDomainReservation(tx *Tx, hostname, deviceID string) (bool, error) {
	var owner string
	err := tx.QueryRow(`SELECT device_id FROM domain_reservations WHERE hostname = ?`, hostname).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return owner == deviceID, nil
}

// ReleaseDomain removes only the reservation owned by deviceID.
func ReleaseDomain(tx *Tx, hostname, deviceID string) error {
	_, err := tx.Exec(`DELETE FROM domain_reservations WHERE hostname = ? AND device_id = ?`, hostname, deviceID)
	return err
}
