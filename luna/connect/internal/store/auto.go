package store

import (
	"database/sql"
	"errors"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"io"
	"os"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

const (
	BackendLocal = "local"
	BackendB2    = "b2"
)

// Auto routes new Puts to B2 when an enabled backup provider exists, else local.
// Get/Delete use the storage_backend recorded on backup_objects so enabling or
// disabling B2 never points at the wrong store (or bills for unreachable bytes).
type Auto struct {
	DB    *database.DB
	Local *Local
	B2    *B2
}

func backupProviderReady(db *database.DB) bool {
	if db == nil {
		return false
	}
	prov, err := providers.NewService(db).FindEnabled("backup")
	if err != nil || prov == nil {
		return false
	}
	return strings.TrimSpace(prov.Credential("account_id", "")) != "" &&
		strings.TrimSpace(prov.Credential("application_key", "")) != ""
}

// PreferredBackend is where new Puts should go given current Admin → Connections.
func PreferredBackend(db *database.DB) string {
	if backupProviderReady(db) {
		return BackendB2
	}
	return BackendLocal
}

func (a *Auto) Put(accountID, deviceID, relPath string, r io.Reader) (int64, string, error) {
	dst := PreferredBackend(a.DB)
	old := a.lookupBackend(accountID, deviceID, relPath)

	// A failed Put cleans up its own partial upload (temp file). It must not delete
	// the destination path: an object already committed there could be the real copy.
	n, _, err := a.put(dst, accountID, deviceID, relPath, r)
	if err != nil {
		return n, dst, err
	}
	if old != "" && old != dst {
		_ = a.del(old, accountID, deviceID, relPath)
	}
	return n, dst, nil
}

func (a *Auto) Get(accountID, deviceID, relPath string) (io.ReadCloser, error) {
	primary := a.backendFor(accountID, deviceID, relPath)
	rc, err := a.get(primary, accountID, deviceID, relPath)
	if err == nil {
		return rc, nil
	}
	// Pre-column or mixed-era objects: try the other backend before failing.
	other := otherBackend(primary)
	rc2, err2 := a.get(other, accountID, deviceID, relPath)
	if err2 == nil {
		return rc2, nil
	}
	return nil, err
}

func (a *Auto) Delete(accountID, deviceID, relPath string) error {
	primary := a.backendFor(accountID, deviceID, relPath)
	err1 := a.del(primary, accountID, deviceID, relPath)
	err2 := a.del(otherBackend(primary), accountID, deviceID, relPath)
	if err1 == nil || err2 == nil {
		return nil
	}
	if isNotExist(err1) && isNotExist(err2) {
		return nil
	}
	if err1 != nil && !isNotExist(err1) {
		return err1
	}
	return err2
}

func (a *Auto) DeleteAccount(accountID string) error {
	b2Err := a.B2.DeleteAccount(accountID)
	localErr := a.Local.DeleteAccount(accountID)
	return errors.Join(b2Err, localErr)
}

// DeleteBackend removes an object from a specific backend (cleanup after Put).
func (a *Auto) DeleteBackend(backend, accountID, deviceID, relPath string) error {
	return a.del(backend, accountID, deviceID, relPath)
}

func (a *Auto) backendFor(accountID, deviceID, relPath string) string {
	if be := a.lookupBackend(accountID, deviceID, relPath); be != "" {
		return be
	}
	// No metadata row (e.g. Put cleanup before INSERT): use preferred destination.
	return PreferredBackend(a.DB)
}

func (a *Auto) lookupBackend(accountID, deviceID, relPath string) string {
	if a.DB == nil {
		return ""
	}
	if be := a.queryBackend(`
SELECT COALESCE(storage_backend, '') FROM backup_objects
WHERE account_id = ? AND device_id = ? AND relative_path = ?`,
		accountID, deviceID, relPath); be != "" {
		return be
	}
	return a.lookupStorageBackend(accountID, deviceID, relPath)
}

// lookupStorageBackend finds the backend of a Connect storage pack or record. Those
// slots are "storage-<luna id>" with paths "packs/<id>" or "records/<kind>/<name>".
func (a *Auto) lookupStorageBackend(accountID, deviceID, relPath string) string {
	lunaID, ok := strings.CutPrefix(deviceID, "storage-")
	if !ok {
		return ""
	}
	if id, ok := strings.CutPrefix(relPath, "packs/"); ok {
		return a.queryBackend(`
SELECT COALESCE(storage_backend, '') FROM storage_packs
WHERE account_id = ? AND luna_id = ? AND id = ?`, accountID, lunaID, id)
	}
	if rest, ok := strings.CutPrefix(relPath, "records/"); ok {
		kind, name, ok := strings.Cut(rest, "/")
		if !ok {
			return ""
		}
		return a.queryBackend(`
SELECT COALESCE(storage_backend, '') FROM storage_records
WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`, accountID, lunaID, kind, name)
	}
	return ""
}

func (a *Auto) queryBackend(query string, args ...any) string {
	var be string
	if err := a.DB.QueryRow(query, args...).Scan(&be); err != nil {
		return ""
	}
	be = strings.ToLower(strings.TrimSpace(be))
	if be == BackendB2 || be == BackendLocal {
		return be
	}
	if be == "" {
		return ""
	}
	return BackendLocal
}

func otherBackend(be string) string {
	if be == BackendB2 {
		return BackendLocal
	}
	return BackendB2
}

func (a *Auto) put(backend, accountID, deviceID, relPath string, r io.Reader) (int64, string, error) {
	switch backend {
	case BackendB2:
		return a.B2.Put(accountID, deviceID, relPath, r)
	default:
		return a.Local.Put(accountID, deviceID, relPath, r)
	}
}

func (a *Auto) get(backend, accountID, deviceID, relPath string) (io.ReadCloser, error) {
	switch backend {
	case BackendB2:
		return a.B2.Get(accountID, deviceID, relPath)
	default:
		return a.Local.Get(accountID, deviceID, relPath)
	}
}

func (a *Auto) del(backend, accountID, deviceID, relPath string) error {
	switch backend {
	case BackendB2:
		return a.B2.Delete(accountID, deviceID, relPath)
	default:
		return a.Local.Delete(accountID, deviceID, relPath)
	}
}

func isNotExist(err error) bool {
	return err != nil && (errors.Is(err, os.ErrNotExist) || errors.Is(err, sql.ErrNoRows) ||
		strings.Contains(strings.ToLower(err.Error()), "not found") ||
		strings.Contains(strings.ToLower(err.Error()), "no such file"))
}
