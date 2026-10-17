package accounts

import (
	"context"
	"errors"
	"io/fs"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

// PurgeStorage deletes an account's cloud storage: every pack and record blob
// in the store, then their metadata rows. A blob that is already gone counts as
// deleted. Any other blob error stops the purge before rows are removed, so a
// retry still finds every blob.
func PurgeStorage(ctx context.Context, db *database.DB, st store.Store, accountID string) error {
	if db == nil || accountID == "" {
		return nil
	}
	type blob struct{ slot, path string }
	var blobs []blob

	prows, err := db.QueryContext(ctx, `SELECT luna_id, id FROM storage_packs WHERE account_id = ?`, accountID)
	if err != nil {
		return err
	}
	for prows.Next() {
		var lunaID, id string
		if err := prows.Scan(&lunaID, &id); err != nil {
			prows.Close()
			return err
		}
		blobs = append(blobs, blob{store.StorageSlot(lunaID), store.StoragePackPath(id)})
	}
	err = prows.Err()
	prows.Close()
	if err != nil {
		return err
	}

	rrows, err := db.QueryContext(ctx, `SELECT luna_id, kind, name FROM storage_records WHERE account_id = ?`, accountID)
	if err != nil {
		return err
	}
	for rrows.Next() {
		var lunaID, kind, name string
		if err := rrows.Scan(&lunaID, &kind, &name); err != nil {
			rrows.Close()
			return err
		}
		blobs = append(blobs, blob{store.StorageSlot(lunaID), store.StorageRecordPath(kind, name)})
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
		if err := st.Delete(accountID, b.slot, b.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}

	if _, err := db.ExecContext(ctx, `DELETE FROM storage_packs WHERE account_id = ?`, accountID); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `DELETE FROM storage_records WHERE account_id = ?`, accountID)
	return err
}
