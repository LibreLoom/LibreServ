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

func RunCleanupLoop(ctx context.Context, db *database.DB) {
	if _, err := CleanupOrphans(ctx, db); err != nil {
		slog.Warn("orphan account cleanup failed", "error", err)
	}
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, err := CleanupOrphans(ctx, db); err != nil {
				slog.Warn("orphan account cleanup failed", "error", err)
			}
		}
	}
}
