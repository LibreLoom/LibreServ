package accounts

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"log/slog"
	"strings"
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

	// Bytes still waiting out their delete grace period go with the rest.
	pend, err := db.QueryContext(ctx, `SELECT luna_id, path, storage_backend FROM storage_pending_deletes WHERE account_id = ?`+lunaClause, args...)
	if err != nil {
		return err
	}
	for pend.Next() {
		var lunaID, path, backend string
		if err := pend.Scan(&lunaID, &path, &backend); err != nil {
			pend.Close()
			return err
		}
		blobs = append(blobs, blob{backend, store.StorageSlot(lunaID), path})
	}
	err = pend.Err()
	pend.Close()
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

	for _, table := range []string{"storage_packs", "storage_records", "storage_pending_deletes", "share_links"} {
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

// pendingDeleteBatch is how many due blobs one pass removes.
const pendingDeleteBatch = 500

// pathIsLive says whether a stored pack or record row still points at a path.
func pathIsLive(ctx context.Context, db *database.DB, accountID, lunaID, path string) (bool, error) {
	var n int
	var err error
	if id, ok := strings.CutPrefix(path, "packs/"); ok {
		err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
			accountID, lunaID, id).Scan(&n)
	} else if rest, ok := strings.CutPrefix(path, "records/"); ok {
		kind, name, _ := strings.Cut(rest, "/")
		err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`,
			accountID, lunaID, kind, name).Scan(&n)
	}
	return n > 0, err
}

// ProcessPendingDeletes removes the bytes of packs and records that Luna deleted at least the grace
// period ago. A blob whose backend fails stays queued and is tried again on the next pass. It returns
// how many blobs it removed.
func ProcessPendingDeletes(ctx context.Context, db *database.DB, st store.Store, now int64) int {
	if db == nil || st == nil {
		return 0
	}
	rows, err := db.QueryContext(ctx, `SELECT account_id, luna_id, path, storage_backend FROM storage_pending_deletes
WHERE delete_after <= ? ORDER BY delete_after LIMIT ?`, now, pendingDeleteBatch)
	if err != nil {
		slog.Error("pending deletes: query", "error", err)
		return 0
	}
	type item struct{ account, luna, path, backend string }
	var due []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.account, &it.luna, &it.path, &it.backend); err != nil {
			rows.Close()
			slog.Error("pending deletes: scan", "error", err)
			return 0
		}
		due = append(due, it)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		slog.Error("pending deletes: read", "error", err)
		return 0
	}
	removed := 0
	for _, it := range due {
		if ctx.Err() != nil {
			break
		}
		forget := func() {
			_, _ = db.ExecContext(ctx, `DELETE FROM storage_pending_deletes WHERE account_id = ? AND luna_id = ? AND path = ?`,
				it.account, it.luna, it.path)
		}
		// Stored again since: the bytes are wanted, so only drop the reminder.
		if live, err := pathIsLive(ctx, db, it.account, it.luna, it.path); err != nil {
			slog.Warn("pending deletes: could not check a piece", "error", err)
			continue
		} else if live {
			forget()
			continue
		}
		err := deleteBlob(st, it.backend, it.account, store.StorageSlot(it.luna), it.path)
		if err != nil && !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, providers.ErrBackupNotConfigured) {
			slog.Warn("pending deletes: a piece could not be removed yet", "backend", it.backend, "error", err)
			continue
		}
		if errors.Is(err, providers.ErrBackupNotConfigured) && it.backend != "local" {
			continue
		}
		// An upload that landed while the bytes were being removed would now point at nothing.
		// Dropping its row makes Luna upload that piece again.
		if live, _ := pathIsLive(ctx, db, it.account, it.luna, it.path); live {
			dropLiveRow(ctx, db, it.account, it.luna, it.path)
		}
		forget()
		removed++
	}
	return removed
}

func dropLiveRow(ctx context.Context, db *database.DB, accountID, lunaID, path string) {
	if id, ok := strings.CutPrefix(path, "packs/"); ok {
		_, _ = db.ExecContext(ctx, `DELETE FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`, accountID, lunaID, id)
	} else if rest, ok := strings.CutPrefix(path, "records/"); ok {
		kind, name, _ := strings.Cut(rest, "/")
		_, _ = db.ExecContext(ctx, `DELETE FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`, accountID, lunaID, kind, name)
	}
}

// RunPendingDeleteLoop removes due blobs once an hour until ctx ends.
func RunPendingDeleteLoop(ctx context.Context, db *database.DB, st store.Store) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		ProcessPendingDeletes(ctx, db, st, time.Now().Unix())
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
