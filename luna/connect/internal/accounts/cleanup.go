package accounts

import (
	"context"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"log/slog"
	"time"
)

const orphanGraceDays = 7

// CleanupOrphans removes Luna Connect accounts that never verified email,
// never bound a Luna, and never added a card — idle signups only.
func CleanupOrphans(ctx context.Context, db *database.DB) (int64, error) {
	if db == nil {
		return 0, nil
	}
	cutoff := time.Now().Add(-orphanGraceDays * 24 * time.Hour).Unix()
	res, err := db.ExecContext(ctx, `
DELETE FROM accounts
WHERE created_at < ?
  AND email_verified = 0
  AND id NOT IN (SELECT DISTINCT account_id FROM devices WHERE account_id IS NOT NULL AND account_id != '')
  AND has_card = 0`, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		slog.Info("luna connect removed idle accounts", "count", n, "grace_days", orphanGraceDays)
	}
	return n, nil
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

func runCleanup(ctx context.Context, db *database.DB) {
	if _, err := CleanupOrphans(ctx, db); err != nil {
		slog.Warn("orphan account cleanup failed", "error", err)
	}
	if _, err := PruneExpired(ctx, db); err != nil {
		slog.Warn("expired row pruning failed", "error", err)
	}
}

func RunCleanupLoop(ctx context.Context, db *database.DB) {
	runCleanup(ctx, db)
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			runCleanup(ctx, db)
		}
	}
}
