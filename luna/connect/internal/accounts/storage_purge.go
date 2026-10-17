package accounts

import (
	"context"
	"errors"
	"io/fs"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

// PurgeStorage deletes an account's cloud storage: every pack and record blob
// in the store, then their metadata rows and the account's Luna identities. A
// blob that is already gone counts as deleted. A local blob whose backend is
// not set up also counts as deleted, since it lives on this server. A B2 blob
// whose provider is not set up is an error: its bytes may still be in the
// cloud, so the rows are kept and a retry can find them. Any blob error stops
// the purge before rows are removed.
func PurgeStorage(ctx context.Context, db *database.DB, st store.Store, accountID string) error {
	if db == nil || accountID == "" {
		return nil
	}
	type blob struct{ backend, slot, path string }
	var blobs []blob

	prows, err := db.QueryContext(ctx, `SELECT luna_id, id, COALESCE(storage_backend, '') FROM storage_packs WHERE account_id = ?`, accountID)
	if err != nil {
		return err
	}
	for prows.Next() {
		var lunaID, id, backend string
		if err := prows.Scan(&lunaID, &id, &backend); err != nil {
			prows.Close()
			return err
		}
		blobs = append(blobs, blob{backend, store.StorageSlot(lunaID), store.StoragePackPath(id)})
	}
	err = prows.Err()
	prows.Close()
	if err != nil {
		return err
	}

	rrows, err := db.QueryContext(ctx, `SELECT luna_id, kind, name, COALESCE(storage_backend, '') FROM storage_records WHERE account_id = ?`, accountID)
	if err != nil {
		return err
	}
	for rrows.Next() {
		var lunaID, kind, name, backend string
		if err := rrows.Scan(&lunaID, &kind, &name, &backend); err != nil {
			rrows.Close()
			return err
		}
		blobs = append(blobs, blob{backend, store.StorageSlot(lunaID), store.StorageRecordPath(kind, name)})
	}
	err = rrows.Err()
	rrows.Close()
	if err != nil {
		return err
	}

	if len(blobs) > 0 && st == nil {
		return errors.New("cloud storage store is not configured")
	}
	for _, b := range blobs {
		err := deleteBlob(st, b.backend, accountID, b.slot, b.path)
		switch {
		case err == nil, errors.Is(err, fs.ErrNotExist):
		case errors.Is(err, providers.ErrBackupNotConfigured) && b.backend == "local":
		default:
			return err
		}
	}

	if _, err := db.ExecContext(ctx, `DELETE FROM storage_packs WHERE account_id = ?`, accountID); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM storage_records WHERE account_id = ?`, accountID); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `DELETE FROM luna_ids WHERE account_id = ?`, accountID)
	return err
}

// deleteBlob removes a blob from the backend that recorded it, when the store can
// say which one that is. Rows without a recorded backend fall back to the store's
// own lookup.
func deleteBlob(st store.Store, backend, accountID, slot, path string) error {
	if ad, ok := st.(interface {
		DeleteBackend(backend, accountID, deviceID, relPath string) error
	}); ok && backend != "" {
		return ad.DeleteBackend(backend, accountID, slot, path)
	}
	return st.Delete(accountID, slot, path)
}
