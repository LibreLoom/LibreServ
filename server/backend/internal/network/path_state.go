package network

import (
	"context"
	"database/sql"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// PathStateStore persists per-app×path verify history (the path_state table,
// migration 007) so the decision engine's hysteresis survives restarts.
type PathStateStore struct {
	db *database.DB
}

func NewPathStateStore(db *database.DB) *PathStateStore {
	return &PathStateStore{db: db}
}

// Get returns the recorded state for one app×path×protocol×port cell.
func (s *PathStateStore) Get(ctx context.Context, appID string, path Path, protocol string, port int) (PathState, error) {
	var st PathState
	var lastVerified, lastFailure sql.NullInt64
	var lastReason sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT consecutive_failures, consecutive_successes,
		        last_verified_at, last_failure_at, last_failure_reason
		 FROM path_state
		 WHERE app_id = ? AND path = ? AND protocol = ? AND port = ?`,
		appID, string(path), protocol, port,
	).Scan(&st.ConsecutiveFailures, &st.ConsecutiveSuccesses, &lastVerified, &lastFailure, &lastReason)
	if err == sql.ErrNoRows {
		return PathState{}, nil
	}
	if err != nil {
		return PathState{}, err
	}
	if lastVerified.Valid {
		st.LastVerifiedAt = lastVerified.Int64
	}
	if lastReason.Valid {
		st.LastFailureReason = lastReason.String
	}
	return st, nil
}

// RecordFailure increments the consecutive-failure counter (resets successes).
func (s *PathStateStore) RecordFailure(ctx context.Context, appID string, path Path, protocol string, port int, reason string) error {
	now := time.Now().Unix()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO path_state (app_id, path, protocol, port, consecutive_failures, consecutive_successes, last_failure_at, last_failure_reason, updated_at)
		 VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)
		 ON CONFLICT(app_id, path, protocol, port) DO UPDATE SET
		   consecutive_failures = consecutive_failures + 1,
		   consecutive_successes = 0,
		   last_failure_at = ?,
		   last_failure_reason = ?,
		   updated_at = ?`,
		appID, string(path), protocol, port, now, reason, now, now, reason, now)
	return err
}

// RecordSuccess increments the consecutive-success counter (resets failures).
func (s *PathStateStore) RecordSuccess(ctx context.Context, appID string, path Path, protocol string, port int) error {
	now := time.Now().Unix()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO path_state (app_id, path, protocol, port, consecutive_failures, consecutive_successes, last_verified_at, updated_at)
		 VALUES (?, ?, ?, ?, 0, 1, ?, ?)
		 ON CONFLICT(app_id, path, protocol, port) DO UPDATE SET
		   consecutive_successes = consecutive_successes + 1,
		   consecutive_failures = 0,
		   last_verified_at = ?,
		   updated_at = ?`,
		appID, string(path), protocol, port, now, now, now, now)
	return err
}

// StateForApp loads all path states for one app into the map the engine needs.
func (s *PathStateStore) StateForApp(ctx context.Context, appID string) (map[Path]PathState, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT path, consecutive_failures, consecutive_successes, last_failure_reason
		 FROM path_state WHERE app_id = ?`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[Path]PathState{}
	for rows.Next() {
		var path string
		var st PathState
		var reason sql.NullString
		if err := rows.Scan(&path, &st.ConsecutiveFailures, &st.ConsecutiveSuccesses, &reason); err != nil {
			return nil, err
		}
		if reason.Valid {
			st.LastFailureReason = reason.String
		}
		out[Path(path)] = st
	}
	return out, rows.Err()
}
