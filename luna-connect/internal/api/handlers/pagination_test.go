package handlers

import (
	"database/sql"
	"net/http/httptest"
	"testing"
)

func TestParseListPageDefaults(t *testing.T) {
	req := httptest.NewRequest("GET", "/admin/devices", nil)
	limit, offset := parseListPage(req)
	if limit != defaultListLimit || offset != 0 {
		t.Fatalf("limit=%d offset=%d", limit, offset)
	}
}

func TestParseListPageQuery(t *testing.T) {
	req := httptest.NewRequest("GET", "/admin/devices?limit=50&offset=100", nil)
	limit, offset := parseListPage(req)
	if limit != 50 || offset != 100 {
		t.Fatalf("limit=%d offset=%d", limit, offset)
	}
}

func TestParseListPageCapsLimit(t *testing.T) {
	req := httptest.NewRequest("GET", "/admin/devices?limit=5000", nil)
	limit, _ := parseListPage(req)
	if limit != maxListLimit {
		t.Fatalf("limit=%d want cap %d", limit, maxListLimit)
	}
}

func TestBuildListPageHasMore(t *testing.T) {
	total := 10
	page := buildListPage(5, 0, 5, &total)
	if !page.HasMore || page.NextOffset == nil || *page.NextOffset != 5 {
		t.Fatalf("page=%+v", page)
	}
}

func TestShouldTouchLastSeenDebounce(t *testing.T) {
	now := int64(1_000_000)
	if !shouldTouchLastSeen(sql.NullInt64{}, now) {
		t.Fatal("null last_seen should touch")
	}
	recent := sql.NullInt64{Int64: now - 30, Valid: true}
	if shouldTouchLastSeen(recent, now) {
		t.Fatal("recent last_seen should not touch")
	}
	old := sql.NullInt64{Int64: now - LastSeenDebounceSec - 1, Valid: true}
	if !shouldTouchLastSeen(old, now) {
		t.Fatal("stale last_seen should touch")
	}
}
