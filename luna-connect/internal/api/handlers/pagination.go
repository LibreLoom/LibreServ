package handlers

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

const (
	defaultListLimit = 500
	maxListLimit     = 1000
)

type listPage struct {
	Limit      int  `json:"limit"`
	Offset     int  `json:"offset"`
	NextOffset *int `json:"next_offset,omitempty"`
	HasMore    bool `json:"has_more"`
	Total      *int `json:"total,omitempty"`
}

func parseListPage(r *http.Request) (limit, offset int) {
	limit = defaultListLimit
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	offset = 0
	if v := strings.TrimSpace(r.URL.Query().Get("offset")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	return limit, offset
}

func buildListPage(limit, offset, rowCount int, total *int) listPage {
	page := listPage{
		Limit:   limit,
		Offset:  offset,
		HasMore: rowCount == limit,
		Total:   total,
	}
	if page.HasMore {
		next := offset + rowCount
		page.NextOffset = &next
	}
	return page
}

// LastSeenDebounceSec skips last_seen_at writes when the device checked in recently.
const LastSeenDebounceSec = 90

// touchLastSeen updates devices.last_seen_at when older than the debounce window.
func touchLastSeen(db *database.DB, deviceID string, now int64) {
	if db == nil || deviceID == "" {
		return
	}
	cutoff := now - LastSeenDebounceSec
	_, _ = db.Exec(`UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
		now, deviceID, cutoff)
}

// shouldTouchLastSeen reports whether a write would happen (for tests).
func shouldTouchLastSeen(lastSeen sql.NullInt64, now int64) bool {
	if !lastSeen.Valid {
		return true
	}
	return lastSeen.Int64 < now-LastSeenDebounceSec
}

// deviceOnlineAt is a test helper around OnlineWithinSec.
func deviceOnlineAt(lastSeen int64, now int64) bool {
	return lastSeen > 0 && now-lastSeen <= OnlineWithinSec
}

// nowUnix is injectable in tests via time.Now().Unix().
var nowUnix = func() int64 { return time.Now().Unix() }
