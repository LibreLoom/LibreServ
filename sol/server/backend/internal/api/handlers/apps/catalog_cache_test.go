package apps

import (
	"fmt"
	"testing"
	"time"
)

// The icon cache is a process-global, so every test here swaps in a fresh
// map and restores the original afterwards.
func withFreshIconCache(t *testing.T) {
	t.Helper()
	iconCache.Lock()
	oldEntries, oldOrder := iconCache.entries, iconCache.order
	iconCache.entries = make(map[string]*iconCacheEntry)
	iconCache.order = nil
	iconCache.Unlock()
	t.Cleanup(func() {
		iconCache.Lock()
		iconCache.entries, iconCache.order = oldEntries, oldOrder
		iconCache.Unlock()
	})
}

func putTestIcon(id string, expired bool) {
	expiresAt := time.Now().Add(time.Hour)
	if expired {
		expiresAt = time.Now().Add(-time.Hour)
	}
	iconCache.entries[id] = &iconCacheEntry{
		data:        []byte("svg-" + id),
		contentType: "image/svg+xml",
		expiresAt:   expiresAt,
	}
	touchIconCacheLocked(id)
}

func TestIconCacheStaysBoundedWithLRUOrder(t *testing.T) {
	withFreshIconCache(t)

	iconCache.Lock()
	for i := 0; i < iconCacheMaxEntries+44; i++ {
		putTestIcon(fmt.Sprintf("app-%03d", i), false)
	}
	evictIconCacheLocked()
	iconCache.Unlock()

	iconCache.RLock()
	defer iconCache.RUnlock()
	if len(iconCache.entries) != iconCacheMaxEntries {
		t.Fatalf("expected %d entries after eviction, got %d", iconCacheMaxEntries, len(iconCache.entries))
	}
	// Oldest inserts are gone, newest survived.
	if _, ok := iconCache.entries["app-000"]; ok {
		t.Error("expected oldest entry app-000 to be evicted")
	}
	if _, ok := iconCache.entries["app-299"]; !ok {
		t.Error("expected newest entry app-299 to survive")
	}
	// Order mirrors the map: no dead IDs, no duplicates.
	seen := make(map[string]bool, len(iconCache.order))
	for _, id := range iconCache.order {
		if _, ok := iconCache.entries[id]; !ok {
			t.Errorf("order carries dead ID %s", id)
		}
		if seen[id] {
			t.Errorf("order carries duplicate ID %s", id)
		}
		seen[id] = true
	}
	if len(iconCache.order) != len(iconCache.entries) {
		t.Errorf("order len %d != entries len %d", len(iconCache.order), len(iconCache.entries))
	}
}

func TestIconCacheRefreshProtectsFromEviction(t *testing.T) {
	withFreshIconCache(t)

	iconCache.Lock()
	putTestIcon("hot", false)
	for i := 0; i < iconCacheMaxEntries; i++ {
		putTestIcon(fmt.Sprintf("filler-%03d", i), false)
	}
	// Refresh "hot" so it is most-recently-used, then overflow again.
	touchIconCacheLocked("hot")
	for i := 0; i < 10; i++ {
		putTestIcon(fmt.Sprintf("late-%02d", i), false)
	}
	evictIconCacheLocked()
	iconCache.Unlock()

	iconCache.RLock()
	defer iconCache.RUnlock()
	if _, ok := iconCache.entries["hot"]; !ok {
		t.Error("expected refreshed entry hot to survive eviction")
	}
	if _, ok := iconCache.entries["filler-000"]; ok {
		t.Error("expected untouched filler-000 to be evicted before hot")
	}
}

func TestIconCacheExpiredPurgeCleansOrder(t *testing.T) {
	withFreshIconCache(t)

	iconCache.Lock()
	for i := 0; i < 10; i++ {
		putTestIcon(fmt.Sprintf("stale-%02d", i), true)
	}
	// Overflow the cap so eviction (and its expired purge) actually runs.
	// Expiry is otherwise enforced lazily on read.
	for i := 0; i < iconCacheMaxEntries; i++ {
		putTestIcon(fmt.Sprintf("fresh-%03d", i), false)
	}
	evictIconCacheLocked()
	iconCache.Unlock()

	iconCache.RLock()
	defer iconCache.RUnlock()
	if len(iconCache.entries) != iconCacheMaxEntries {
		t.Fatalf("expected %d entries after eviction, got %d", iconCacheMaxEntries, len(iconCache.entries))
	}
	for id := range iconCache.entries {
		if len(id) >= 6 && id[:6] == "stale-" {
			t.Errorf("expired entry %s survived eviction", id)
		}
	}
	for _, id := range iconCache.order {
		if _, ok := iconCache.entries[id]; !ok {
			t.Errorf("order carries purged ID %s", id)
		}
	}
}
