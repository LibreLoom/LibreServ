package accounts

import (
	"context"
	"log/slog"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

const orphanGraceDays = 7

// orphanWhere matches idle signups: email never verified, no Luna bound, no card.
const orphanWhere = `created_at < ?
  AND email_verified = 0
  AND id NOT IN (SELECT DISTINCT account_id FROM devices WHERE account_id IS NOT NULL AND account_id != '')
  AND has_card = 0`

// CleanupOrphans removes Luna Connect accounts that never verified email,
// never bound a Luna, and never added a card — idle signups only. Each one's
// cloud storage is purged before its row is removed.
func CleanupOrphans(ctx context.Context, db *database.DB, st store.Store) (int64, error) {
	if db == nil {
		return 0, nil
	}
	cutoff := time.Now().Add(-orphanGraceDays * 24 * time.Hour).Unix()
	rows, err := db.QueryContext(ctx, `SELECT id FROM accounts WHERE `+orphanWhere, cutoff)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	var removed int64
	for _, id := range ids {
		// One account's storage failing must not block the others. Its row is kept, so
		// the next run finds its blobs and tries again.
		if err := PurgeStorage(ctx, db, st, id); err != nil {
			slog.Warn("luna connect could not purge an idle account's cloud storage; will retry next run", "error", err)
			continue
		}
		res, err := db.ExecContext(ctx, `DELETE FROM accounts WHERE id = ? AND `+orphanWhere, id, cutoff)
		if err != nil {
			return removed, err
		}
		n, _ := res.RowsAffected()
		removed += n
	}
	if removed > 0 {
		slog.Info("luna connect removed idle accounts", "count", removed, "grace_days", orphanGraceDays)
	}
	return removed, nil
}

// attemptRetainSec keeps rate-limit rows a day past their last hit so
// diagnostics still see a hot key; windows are ≤1h, so nothing relied on
// longer retention.
const attemptRetainSec = 24 * 3600

// PruneExpired deletes rows whose TTL has passed: expired sign-in sessions,
// expired admin sessions, spent/expired email verification tokens, and
// rate-limit buckets idle for more than a day. Runs in the daily cleanup loop
// so auth tables do not grow without bound.
func PruneExpired(ctx context.Context, db *database.DB) (int64, error) {
	if db == nil {
		return 0, nil
	}
	now := time.Now().Unix()
	stmts := []struct {
		q   string
		arg int64
	}{
		{`DELETE FROM sessions WHERE expires_at < ?`, now},
		{`DELETE FROM admin_sessions WHERE expires_at < ?`, now},
		{`DELETE FROM email_verification_tokens WHERE expires_at < ?`, now},
		{`DELETE FROM guess_attempts WHERE last < ?`, now - attemptRetainSec},
		{`DELETE FROM register_attempts WHERE start < ?`, now - attemptRetainSec},
	}
	var total int64
	for _, s := range stmts {
		res, err := db.ExecContext(ctx, s.q, s.arg)
		if err != nil {
			return total, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			total += n
		}
	}
	if total > 0 {
		slog.Info("luna connect pruned expired auth rows", "count", total)
	}
	return total, nil
}

func runCleanup(ctx context.Context, db *database.DB, st store.Store) {
	if _, err := CleanupOrphans(ctx, db, st); err != nil {
		slog.Warn("orphan account cleanup failed", "error", err)
	}
	if _, err := PruneExpired(ctx, db); err != nil {
		slog.Warn("expired row pruning failed", "error", err)
	}
}

func RunCleanupLoop(ctx context.Context, db *database.DB, st store.Store) {
	runCleanup(ctx, db, st)
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			runCleanup(ctx, db, st)
		}
	}
}
