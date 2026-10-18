package accounts

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"log/slog"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

// PurgeStorage deletes an account's cloud storage: every pack and record blob
// in the store, then their metadata rows, share links and the account's Luna
// identities. A blob that is already gone counts as deleted. A local blob whose
// backend is not set up also counts as deleted, since it lives on this server. A
// B2 blob whose provider is not set up is an error: its bytes may still be in the
// cloud, so the rows are kept and a retry can find them. Any blob error stops the
// purge before rows are removed.
func PurgeStorage(ctx context.Context, db *database.DB, st store.Store, accountID string) error {
	return purgeStorage(ctx, db, st, accountID, "")
}

// PurgeLunaStorage deletes one Luna's cloud storage on an account: its pack and
// record blobs, their rows, its share links and its luna_ids row. Same blob rules
// as PurgeStorage. An empty lunaID deletes nothing, so a caller cannot wipe the
// whole account by accident.
func PurgeLunaStorage(ctx context.Context, db *database.DB, st store.Store, accountID, lunaID string) error {
	if lunaID == "" {
		return nil
	}
	return purgeStorage(ctx, db, st, accountID, lunaID)
}

// purgeStorage does the work for PurgeStorage and PurgeLunaStorage. An empty
// lunaID means every Luna on the account.
//
// For one Luna, the purge first claims it: purge_after moves to -1 only while it is still due,
// so a second run or a relink cannot overlap it. If the purge fails, the old purge_after comes
// back so the next retention run tries again.
func purgeStorage(ctx context.Context, db *database.DB, st store.Store, accountID, lunaID string) (err error) {
	if db == nil || accountID == "" {
		return nil
	}
	if lunaID != "" {
		old, claimed, claimErr := claimLunaForPurge(ctx, db, accountID, lunaID, time.Now().Unix())
		if claimErr != nil || !claimed {
			return claimErr
		}
		defer func() {
			if err != nil {
				_, _ = db.ExecContext(ctx, `UPDATE luna_ids SET purge_after = ? WHERE account_id = ? AND luna_id = ? AND purge_after = -1`,
					old, accountID, lunaID)
			}
		}()
	}
	lunaClause := ""
	args := []any{accountID}
	if lunaID != "" {
		lunaClause = " AND luna_id = ?"
		args = append(args, lunaID)
	}
	type blob struct{ backend, slot, path string }
	var blobs []blob

	prows, err := db.QueryContext(ctx, `SELECT luna_id, id, COALESCE(storage_backend, '') FROM storage_packs WHERE account_id = ?`+lunaClause, args...)
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

	rrows, err := db.QueryContext(ctx, `SELECT luna_id, kind, name, COALESCE(storage_backend, '') FROM storage_records WHERE account_id = ?`+lunaClause, args...)
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

	for _, table := range []string{"storage_packs", "storage_records", "share_links"} {
		if _, err := db.ExecContext(ctx, `DELETE FROM `+table+` WHERE account_id = ?`+lunaClause, args...); err != nil {
			return err
		}
	}
	if _, err = db.ExecContext(ctx, `DELETE FROM luna_ids WHERE account_id = ?`+lunaClause, args...); err != nil {
		return err
	}
	// The blobs are gone, so give the B2 buckets and keys back. This is best effort: a bucket
	// that cannot be deleted now is only a spare bucket, not lost data.
	if rel, ok := st.(interface {
		ReleaseBuckets(accountID, lunaID string) error
	}); ok {
		if relErr := rel.ReleaseBuckets(accountID, lunaID); relErr != nil && !errors.Is(relErr, providers.ErrBackupNotConfigured) {
			slog.Warn("purge storage: could not free Backblaze buckets", "error", relErr)
		}
	}
	return nil
}

// claimLunaForPurge sets a due Luna's purge_after to -1 and returns the value it had. A Luna at
// -1 was claimed by a purge that never finished, so it is claimed again to retry that purge. It
// reports false when the Luna is not due and not claimed, or is linked again.
func claimLunaForPurge(ctx context.Context, db *database.DB, accountID, lunaID string, now int64) (int64, bool, error) {
	var old int64
	err := db.QueryRowContext(ctx, `SELECT purge_after FROM luna_ids WHERE account_id = ? AND luna_id = ?`,
		accountID, lunaID).Scan(&old)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	res, err := db.ExecContext(ctx, `UPDATE luna_ids SET purge_after = -1 WHERE account_id = ? AND luna_id = ? AND purge_after = ? AND (purge_after = -1 OR (purge_after > 0 AND purge_after <= ?))`,
		accountID, lunaID, old, now)
	if err != nil {
		return 0, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, false, err
	}
	return old, n == 1, nil
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
